begin;

-- Match the web client's name normalization, including provider HTML entities.
create or replace function public.bank_review_normalized_name(p_name text)
returns text language plpgsql immutable security invoker set search_path = '' as $$
declare
  decoded text := coalesce(p_name, '');
  entity text[];
  point integer;
  tail text;
  position integer;
begin
  for entity in select regexp_matches(decoded, '&#(x[0-9a-f]+|[0-9]+);', 'gi') loop
    begin
      if lower(left(entity[1], 1)) = 'x' then
        point := ('x' || lpad(substr(entity[1], 2), 8, '0'))::bit(32)::integer;
      else point := entity[1]::integer;
      end if;
      if point between 1 and 1114111 and point not between 55296 and 57343 then
        decoded := replace(decoded, '&#' || entity[1] || ';', chr(point));
      end if;
    exception when others then null;
    end;
  end loop;
  tail := decoded;
  decoded := '';
  loop
    entity := regexp_match(tail, '(&(amp|quot|apos|lt|gt);)', 'i');
    exit when entity is null;
    position := strpos(tail, entity[1]);
    decoded := decoded || left(tail, position - 1) || case lower(entity[2])
      when 'amp' then '&' when 'quot' then '"' when 'apos' then '''' when 'lt' then '<' else '>' end;
    tail := substr(tail, position + length(entity[1]));
  end loop;
  decoded := decoded || tail;
  return lower(btrim(regexp_replace(normalize(decoded, NFKC), '\s+', ' ', 'g')));
end;
$$;

create or replace function public.bank_review_resolve_payee(p_workspace_id uuid, p_name text)
returns uuid language plpgsql stable security invoker set search_path = '' as $$
declare
  name_key text := public.bank_review_normalized_name(p_name);
  resolved uuid;
  prefix_ids uuid[];
begin
  if name_key = '' then return null; end if;
  select mapping.payee_id into resolved from public.payee_mappings mapping
  join public.payees payee on payee.workspace_id = mapping.workspace_id and payee.id = mapping.payee_id
  where mapping.workspace_id = p_workspace_id and mapping.match_type = 'exact' and mapping.normalized_name = name_key
  order by mapping.id limit 1;
  if resolved is not null then return resolved; end if;
  select payee.id into resolved from public.payees payee
  where payee.workspace_id = p_workspace_id and public.bank_review_normalized_name(payee.name) = name_key
  order by payee.id limit 1;
  if resolved is not null then return resolved; end if;
  with matches as (
    select mapping.payee_id, length(mapping.normalized_name) as size from public.payee_mappings mapping
    join public.payees payee on payee.workspace_id = mapping.workspace_id and payee.id = mapping.payee_id
    where mapping.workspace_id = p_workspace_id and mapping.match_type = 'starts_with'
      and left(name_key, length(mapping.normalized_name)) = mapping.normalized_name
      and length(name_key) > length(mapping.normalized_name)
  ) select array_agg(distinct payee_id) into prefix_ids from matches where size = (select max(size) from matches);
  if cardinality(prefix_ids) = 1 then return prefix_ids[1]; end if;
  return null;
end;
$$;

-- Old clients keep their existing RPC. This adds an atomic, retry-safe web path.
create or replace function public.approve_bank_review_item(
  p_workspace_id uuid, p_account_id uuid, p_candidate_id uuid, p_category_id uuid,
  p_payee_id uuid default null, p_memo text default '', p_remember_category boolean default false,
  p_set_payee_defaults boolean default false, p_remember_mapping boolean default false
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  candidate public.bank_import_candidates%rowtype;
  remaining public.bank_import_candidates%rowtype;
  chosen_payee uuid;
  matched_payee uuid;
  transaction_id uuid;
  mapping public.payee_mappings%rowtype;
  rematched jsonb := '[]'::jsonb;
  result jsonb;
  name_key text;
begin
  if not public.is_workspace_member(p_workspace_id) then raise exception 'Workspace access denied.'; end if;
  -- Serialize this path's payee/period creation and mapping updates per workspace.
  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text, 72));
  select * into candidate from public.bank_import_candidates
  where workspace_id = p_workspace_id and account_id = p_account_id and id = p_candidate_id for update;
  if candidate.id is null then raise exception 'The bank transaction awaiting review no longer exists on this account.'; end if;
  if candidate.status = 'approved' and candidate.transaction_id is not null then
    transaction_id := candidate.transaction_id;
    chosen_payee := candidate.payee_id;
    -- Recover related confirmed state too when the first response was lost.
    select * into mapping from public.payee_mappings
    where workspace_id = p_workspace_id and lower(btrim(normalize(source_name, NFKC))) = lower(btrim(normalize(candidate.payee_name, NFKC)))
    order by id limit 1;
    select coalesce(jsonb_agg(jsonb_build_object('id', pending.id, 'payee_id', pending.payee_id, 'category_id', pending.category_id)), '[]'::jsonb)
    into rematched from public.bank_import_candidates pending
    where workspace_id = p_workspace_id and account_id = p_account_id and status = 'pending' and payee_id is not null;
  else
    if candidate.status <> 'pending' then raise exception 'Only pending bank transactions can be approved.'; end if;
    if not exists (select 1 from public.categories where workspace_id = p_workspace_id and id = p_category_id and not hidden) then
      raise exception 'Choose an active category before approving this transaction.';
    end if;
    chosen_payee := p_payee_id;
    if chosen_payee is null then
      chosen_payee := public.bank_review_resolve_payee(p_workspace_id, candidate.payee_name);
      if chosen_payee is null then
        if public.bank_review_normalized_name(candidate.payee_name) = '' then raise exception 'A bank description is required to create a payee.'; end if;
        chosen_payee := gen_random_uuid();
        insert into public.payees(id, workspace_id, name, sort_order)
        values (chosen_payee, p_workspace_id, btrim(normalize(candidate.payee_name, NFKC)),
          coalesce((select max(sort_order) + 1 from public.payees where workspace_id = p_workspace_id), 0));
      end if;
    end if;
    if not exists (select 1 from public.payees where workspace_id = p_workspace_id and id = chosen_payee) then raise exception 'Choose a payee from this workspace.'; end if;
    update public.bank_import_candidates set payee_id = chosen_payee, memo = nullif(btrim(normalize(coalesce(p_memo, ''), NFKC)), '')
    where workspace_id = p_workspace_id and id = candidate.id;
    transaction_id := public.approve_bank_import_candidate(p_workspace_id, candidate.id, p_category_id, p_remember_category);
    if p_set_payee_defaults then
      update public.payees set default_category_id = p_category_id, default_account_id = p_account_id
      where workspace_id = p_workspace_id and id = chosen_payee;
    end if;
    if p_remember_mapping and btrim(candidate.payee_name) <> '' then
      name_key := lower(btrim(normalize(candidate.payee_name, NFKC)));
      select * into mapping from public.payee_mappings
      where workspace_id = p_workspace_id and lower(btrim(normalize(source_name, NFKC))) = name_key order by id limit 1 for update;
      if mapping.id is null then
        insert into public.payee_mappings(id, workspace_id, source_name, normalized_name, payee_id)
        values (gen_random_uuid(), p_workspace_id, btrim(normalize(candidate.payee_name, NFKC)), public.bank_review_normalized_name(candidate.payee_name), chosen_payee)
        returning * into mapping;
      elsif mapping.payee_id <> chosen_payee then
        update public.payee_mappings set payee_id = chosen_payee, source_name = btrim(normalize(candidate.payee_name, NFKC)),
          normalized_name = public.bank_review_normalized_name(candidate.payee_name)
        where workspace_id = p_workspace_id and id = mapping.id returning * into mapping;
      end if;
      -- Preserve the existing rematch behavior without client round trips.
      for remaining in select * from public.bank_import_candidates
        where workspace_id = p_workspace_id and account_id = p_account_id and status = 'pending' and payee_id is null for update loop
        matched_payee := coalesce(public.bank_review_resolve_payee(p_workspace_id, remaining.payee_name), public.bank_review_resolve_payee(p_workspace_id, remaining.bank_memo));
        if matched_payee is not null then
          update public.bank_import_candidates set payee_id = matched_payee,
            category_id = coalesce((select default_category_id from public.payees where workspace_id = p_workspace_id and id = matched_payee), category_id)
          where workspace_id = p_workspace_id and id = remaining.id returning * into remaining;
          rematched := rematched || jsonb_build_array(jsonb_build_object('id', remaining.id, 'payee_id', remaining.payee_id, 'category_id', remaining.category_id));
        end if;
      end loop;
    end if;
  end if;
  select jsonb_build_object(
    'candidateId', candidate.id, 'accountId', candidate.account_id,
    'transaction', to_jsonb(ledger) || jsonb_build_object('payee', payee.name),
    'payee', to_jsonb(payee), 'mapping', case when mapping.id is null then null else to_jsonb(mapping) end,
    'rematched', rematched,
    'pendingCount', (select count(*) from public.bank_import_candidates where workspace_id = p_workspace_id and account_id = p_account_id and status = 'pending'),
    'balanceMinor', (select balance_minor from public.workspace_account_balances(p_workspace_id) where account_id = p_account_id)
  ) into result from public.transactions ledger
  join public.payees payee on payee.workspace_id = ledger.workspace_id and payee.id = ledger.payee_id
  where ledger.workspace_id = p_workspace_id and ledger.id = transaction_id;
  if result is null then raise exception 'The approved transaction could not be verified.'; end if;
  return result;
end;
$$;

revoke all on function public.bank_review_normalized_name(text) from public;
revoke all on function public.bank_review_resolve_payee(uuid, text) from public;
revoke all on function public.approve_bank_review_item(uuid, uuid, uuid, uuid, uuid, text, boolean, boolean, boolean) from public;
grant execute on function public.bank_review_normalized_name(text) to authenticated;
grant execute on function public.bank_review_resolve_payee(uuid, text) to authenticated;
grant execute on function public.approve_bank_review_item(uuid, uuid, uuid, uuid, uuid, text, boolean, boolean, boolean) to authenticated;
notify pgrst, 'reload schema';
commit;
