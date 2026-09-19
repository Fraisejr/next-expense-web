begin;

alter table public.transactions add column bank_memo text;
alter table public.bank_import_candidates add column bank_memo text;

-- Approved candidates contain the authoritative provider memo when available.
update public.bank_import_candidates
set bank_memo = memo
where bank_memo is null and nullif(btrim(memo), '') is not null;

update public.transactions transaction
set bank_memo = candidate.bank_memo
from public.bank_import_candidates candidate
where candidate.workspace_id = transaction.workspace_id
  and candidate.transaction_id = transaction.id
  and nullif(btrim(candidate.bank_memo), '') is not null;

-- Keep every migrated memo in place as an editable legacy note while also
-- preserving a copy before either app allows it to be changed.
update public.transactions
set bank_memo = memo
where bank_memo is null
  and source in ('gocardless', 'ios_import')
  and nullif(btrim(memo), '') is not null;

-- Review imports could not previously have a user-authored memo, so their old
-- memo is purely provider data. Move it rather than showing it twice.
update public.bank_import_candidates
set memo = null
where bank_memo is not null;

create or replace function public.approve_bank_import_candidate(
  p_workspace_id uuid,
  p_candidate_id uuid,
  p_category_id uuid,
  p_remember_category boolean default false
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  candidate public.bank_import_candidates%rowtype;
  existing_transaction public.transactions%rowtype;
  target_period_id uuid;
  created_transaction_id uuid;
  linked_payee_id uuid;
begin
  select * into candidate
  from public.bank_import_candidates
  where workspace_id = p_workspace_id and id = p_candidate_id
  for update;

  if candidate.id is null then raise exception 'The bank transaction awaiting review no longer exists.'; end if;
  if candidate.status = 'approved' and candidate.transaction_id is not null then return candidate.transaction_id; end if;
  if candidate.status <> 'pending' then raise exception 'Only pending bank transactions can be approved.'; end if;
  if not exists (select 1 from public.categories where workspace_id = p_workspace_id and id = p_category_id and not hidden) then
    raise exception 'Choose an active category before approving this transaction.';
  end if;

  select id into target_period_id from public.periods
  where workspace_id = p_workspace_id
    and year = extract(year from candidate.transaction_date)::integer
    and month = extract(month from candidate.transaction_date)::integer;
  if target_period_id is null then
    target_period_id := gen_random_uuid();
    insert into public.periods (id, workspace_id, year, month, month_label, period_start_date, source_start_at)
    values (target_period_id, p_workspace_id, extract(year from candidate.transaction_date)::integer,
      extract(month from candidate.transaction_date)::integer, to_char(candidate.transaction_date, 'YYYY-MM'),
      date_trunc('month', candidate.transaction_date)::date, date_trunc('month', candidate.transaction_date)::timestamptz);
  end if;

  if candidate.transaction_id is not null then
    select * into existing_transaction from public.transactions
    where workspace_id = p_workspace_id and id = candidate.transaction_id and account_id = candidate.account_id
    for update;
  end if;

  linked_payee_id := coalesce(candidate.payee_id, existing_transaction.payee_id);
  if linked_payee_id is null then
    select id into linked_payee_id from public.payees
    where workspace_id = p_workspace_id and lower(btrim(name)) = lower(btrim(candidate.payee_name))
    order by created_at, id limit 1;
    if linked_payee_id is null then
      linked_payee_id := gen_random_uuid();
      insert into public.payees (id, workspace_id, name, sort_order)
      values (linked_payee_id, p_workspace_id, btrim(candidate.payee_name),
        coalesce((select max(sort_order) + 1 from public.payees where workspace_id = p_workspace_id), 0));
    end if;
  end if;

  if existing_transaction.id is not null then
    if existing_transaction.transaction_type = 'transfer' then raise exception 'A transfer cannot be approved as a categorized bank transaction.'; end if;
    created_transaction_id := existing_transaction.id;
    update public.transactions set period_id = target_period_id, category_id = p_category_id, payee_id = linked_payee_id,
      transaction_date = candidate.transaction_date, source_timestamp = (candidate.transaction_date::text || 'T12:00:00Z')::timestamptz,
      source_created_at = candidate.fetched_at, amount_minor = candidate.amount_minor, destination_amount_minor = 0,
      currency = candidate.currency, transaction_type = candidate.transaction_type, payee_name = candidate.payee_name,
      memo = candidate.memo, bank_memo = candidate.bank_memo, provider_transaction_id = candidate.provider_transaction_id,
      bank_transaction_id = candidate.bank_transaction_id, posted = candidate.posted, reconciled = candidate.posted, source = 'gocardless'
    where workspace_id = p_workspace_id and id = existing_transaction.id;
  else
    created_transaction_id := gen_random_uuid();
    insert into public.transactions (id, workspace_id, account_id, period_id, category_id, payee_id, transaction_date,
      source_timestamp, source_created_at, amount_minor, destination_amount_minor, currency, transaction_type, payee_name,
      memo, bank_memo, provider_transaction_id, bank_transaction_id, posted, reconciled, source)
    values (created_transaction_id, p_workspace_id, candidate.account_id, target_period_id, p_category_id, linked_payee_id,
      candidate.transaction_date, (candidate.transaction_date::text || 'T12:00:00Z')::timestamptz, candidate.fetched_at,
      candidate.amount_minor, 0, candidate.currency, candidate.transaction_type, candidate.payee_name, candidate.memo,
      candidate.bank_memo, candidate.provider_transaction_id, candidate.bank_transaction_id, candidate.posted, candidate.posted, 'gocardless');
  end if;

  insert into public.bank_transaction_refs (workspace_id, transaction_id, account_id, provider, provider_transaction_id, bank_transaction_id)
  values (p_workspace_id, created_transaction_id, candidate.account_id, candidate.provider, candidate.provider_transaction_id, candidate.bank_transaction_id)
  on conflict do nothing;

  update public.bank_import_candidates set status = 'approved', category_id = p_category_id, payee_id = linked_payee_id,
    transaction_id = created_transaction_id, decided_at = now()
  where workspace_id = p_workspace_id and id = candidate.id;

  if p_remember_category then
    update public.payees set default_category_id = p_category_id
    where workspace_id = p_workspace_id and id = linked_payee_id;
  end if;
  return created_transaction_id;
end;
$$;

create or replace function public.create_bank_import_transfer_from_candidate(
  p_workspace_id uuid,
  p_candidate_id uuid,
  p_counterparty_account_id uuid
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  candidate public.bank_import_candidates%rowtype;
  counterparty_account public.accounts%rowtype;
  existing_transaction public.transactions%rowtype;
  target_period_id uuid;
  created_transaction_id uuid;
  source_account_id uuid;
  destination_account_id uuid;
begin
  select * into candidate from public.bank_import_candidates
  where workspace_id = p_workspace_id and id = p_candidate_id for update;
  if candidate.id is null then raise exception 'The bank transaction awaiting review no longer exists.'; end if;
  if candidate.status = 'approved' and candidate.transaction_id is not null then return candidate.transaction_id; end if;
  if candidate.status <> 'pending' then raise exception 'Only pending bank transactions can be posted as transfers.'; end if;

  select * into counterparty_account from public.accounts
  where workspace_id = p_workspace_id and id = p_counterparty_account_id;
  if counterparty_account.id is null or counterparty_account.id = candidate.account_id then raise exception 'Choose another account for the transfer.'; end if;
  if counterparty_account.currency <> candidate.currency then raise exception 'Bank-import transfers currently require accounts in the same currency.'; end if;

  select id into target_period_id from public.periods
  where workspace_id = p_workspace_id
    and year = extract(year from candidate.transaction_date)::integer
    and month = extract(month from candidate.transaction_date)::integer;
  if target_period_id is null then
    target_period_id := pg_catalog.gen_random_uuid();
    insert into public.periods (id, workspace_id, year, month, month_label, period_start_date, source_start_at)
    values (target_period_id, p_workspace_id, extract(year from candidate.transaction_date)::integer,
      extract(month from candidate.transaction_date)::integer, pg_catalog.to_char(candidate.transaction_date, 'YYYY-MM'),
      pg_catalog.date_trunc('month', candidate.transaction_date)::date, pg_catalog.date_trunc('month', candidate.transaction_date)::timestamptz);
  end if;

  if candidate.transaction_type = 'expense' then
    source_account_id := candidate.account_id; destination_account_id := counterparty_account.id;
  else
    source_account_id := counterparty_account.id; destination_account_id := candidate.account_id;
  end if;

  if candidate.transaction_id is not null then
    select * into existing_transaction from public.transactions
    where workspace_id = p_workspace_id and id = candidate.transaction_id for update;
  end if;

  if existing_transaction.id is not null then
    created_transaction_id := existing_transaction.id;
    update public.transactions set account_id = source_account_id, destination_account_id = destination_account_id,
      period_id = target_period_id, category_id = null, payee_id = null, debtor_id = null,
      transaction_date = candidate.transaction_date, source_timestamp = (candidate.transaction_date::text || 'T12:00:00Z')::timestamptz,
      source_created_at = candidate.fetched_at, amount_minor = candidate.amount_minor,
      destination_amount_minor = candidate.amount_minor, currency = candidate.currency, transaction_type = 'transfer',
      payee_name = candidate.payee_name, memo = candidate.memo, bank_memo = candidate.bank_memo,
      provider_transaction_id = candidate.provider_transaction_id, bank_transaction_id = candidate.bank_transaction_id,
      posted = candidate.posted, reconciled = candidate.posted, source = 'gocardless', legacy_missing_payee = false
    where workspace_id = p_workspace_id and id = existing_transaction.id;
  else
    created_transaction_id := pg_catalog.gen_random_uuid();
    insert into public.transactions (id, workspace_id, account_id, destination_account_id, period_id,
      category_id, payee_id, debtor_id, transaction_date, source_timestamp, source_created_at,
      amount_minor, destination_amount_minor, currency, transaction_type, payee_name, memo, bank_memo,
      provider_transaction_id, bank_transaction_id, posted, reconciled, source, legacy_missing_payee)
    values (created_transaction_id, p_workspace_id, source_account_id, destination_account_id, target_period_id,
      null, null, null, candidate.transaction_date, (candidate.transaction_date::text || 'T12:00:00Z')::timestamptz,
      candidate.fetched_at, candidate.amount_minor, candidate.amount_minor, candidate.currency, 'transfer',
      candidate.payee_name, candidate.memo, candidate.bank_memo, candidate.provider_transaction_id,
      candidate.bank_transaction_id, candidate.posted, candidate.posted, 'gocardless', false);
  end if;

  insert into public.bank_transaction_refs (workspace_id, transaction_id, account_id, provider, provider_transaction_id, bank_transaction_id)
  values (p_workspace_id, created_transaction_id, candidate.account_id, candidate.provider, candidate.provider_transaction_id, candidate.bank_transaction_id)
  on conflict do nothing;
  update public.bank_import_candidates set status = 'approved', category_id = null, payee_id = null,
    transaction_id = created_transaction_id, decided_at = pg_catalog.now()
  where workspace_id = p_workspace_id and id = candidate.id;
  return created_transaction_id;
end;
$$;

create or replace function public.assign_payee_mapping(
  p_workspace_id uuid,
  p_source_name text,
  p_payee_id uuid
)
returns uuid[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  linked_transaction_ids uuid[];
  target_default_category_id uuid;
begin
  if not public.is_workspace_member(p_workspace_id) then raise exception 'Workspace access denied' using errcode = '42501'; end if;
  if length(btrim(p_source_name)) = 0 then raise exception 'A bank description is required' using errcode = '22023'; end if;

  select payee.default_category_id into target_default_category_id
  from public.payees payee
  where payee.workspace_id = p_workspace_id and payee.id = p_payee_id;
  if not found then raise exception 'Payee not found' using errcode = '22023'; end if;

  if target_default_category_id is null and exists (
    select 1 from public.transactions transaction
    where transaction.workspace_id = p_workspace_id and transaction.payee_id is null
      and transaction.category_id is null and transaction.transaction_type in ('expense', 'income')
      and lower(btrim(coalesce(nullif(btrim(transaction.payee_name), ''),
        nullif(btrim(transaction.bank_memo), ''), 'Unknown payee'))) = lower(btrim(p_source_name))
  ) then
    raise exception 'Choose a default category for this payee before mapping uncategorized transactions.' using errcode = '22023';
  end if;

  insert into public.payee_mappings (id, workspace_id, normalized_name, source_name, payee_id)
  values (pg_catalog.gen_random_uuid(), p_workspace_id, lower(btrim(p_source_name)), btrim(p_source_name), p_payee_id)
  on conflict (workspace_id, source_name, payee_id) do nothing;

  with linked as (
    update public.transactions transaction
    set payee_id = p_payee_id, category_id = coalesce(transaction.category_id, target_default_category_id)
    where transaction.workspace_id = p_workspace_id and transaction.payee_id is null
      and transaction.transaction_type in ('expense', 'income')
      and lower(btrim(coalesce(nullif(btrim(transaction.payee_name), ''),
        nullif(btrim(transaction.bank_memo), ''), 'Unknown payee'))) = lower(btrim(p_source_name))
    returning transaction.id
  )
  select coalesce(array_agg(linked.id), array[]::uuid[]) into linked_transaction_ids from linked;
  if cardinality(linked_transaction_ids) = 0 then raise exception 'No unmatched transactions matched this description' using errcode = 'P0002'; end if;
  return linked_transaction_ids;
end;
$$;

drop function public.list_workspace_transactions(uuid, integer, integer, text, uuid, uuid, uuid, boolean, date, date);

create function public.list_workspace_transactions(
  p_workspace_id uuid, p_limit integer default 1000, p_offset integer default 0,
  p_search text default null, p_account_id uuid default null, p_category_id uuid default null,
  p_payee_id uuid default null, p_uncategorized boolean default false,
  p_start_date date default null, p_end_date date default null
)
returns table(
  id uuid, transaction_date date, payee text, payee_id uuid, debtor_id uuid,
  memo text, bank_memo text, amount_minor bigint, destination_amount_minor bigint,
  transaction_type text, account_id uuid, category_id uuid, destination_account_id uuid,
  currency text, payee_name text, source text, provider_transaction_id text, posted boolean,
  balance_checkpoint_minor bigint, adjustment_reason text, total_count bigint
)
language sql stable security invoker set search_path = ''
as $$
  with filtered as (
    select ledger_transaction.*,
      case
        when ledger_transaction.transaction_type = 'opening_balance' then 'Opening balance'
        when ledger_transaction.transaction_type = 'balance_adjustment' then 'Balance adjustment'
        else coalesce(resolved_payee.name, ledger_transaction.payee_name, ledger_transaction.memo, 'Unknown payee')
      end as display_payee
    from public.transactions ledger_transaction
    left join public.payees resolved_payee on resolved_payee.id = ledger_transaction.payee_id
    left join public.categories category on category.id = ledger_transaction.category_id
    left join public.accounts source_account on source_account.id = ledger_transaction.account_id
    left join public.accounts destination_account on destination_account.id = ledger_transaction.destination_account_id
    where ledger_transaction.workspace_id = p_workspace_id
      and (p_account_id is null or ledger_transaction.account_id = p_account_id or ledger_transaction.destination_account_id = p_account_id)
      and (p_category_id is null or ledger_transaction.category_id = p_category_id)
      and (p_payee_id is null or ledger_transaction.payee_id = p_payee_id)
      and (not p_uncategorized or (ledger_transaction.transaction_type in ('expense', 'income') and ledger_transaction.category_id is null))
      and (p_start_date is null or ledger_transaction.transaction_date >= p_start_date)
      and (p_end_date is null or ledger_transaction.transaction_date < p_end_date)
      and (nullif(trim(p_search), '') is null or concat_ws(' ', resolved_payee.name,
        ledger_transaction.payee_name, ledger_transaction.memo, ledger_transaction.bank_memo,
        category.name, source_account.name, destination_account.name, ledger_transaction.transaction_date::text)
        ilike '%' || trim(p_search) || '%')
  )
  select filtered.id, filtered.transaction_date, filtered.display_payee, filtered.payee_id,
    filtered.debtor_id, filtered.memo, filtered.bank_memo,
    case when filtered.transaction_type = 'balance_adjustment'
      then public.effective_balance_adjustment_amount(filtered.workspace_id, filtered.account_id, filtered.transaction_date, filtered.balance_checkpoint_minor)
      else filtered.amount_minor end,
    filtered.destination_amount_minor, filtered.transaction_type, filtered.account_id,
    filtered.category_id, filtered.destination_account_id, filtered.currency, filtered.payee_name,
    filtered.source, filtered.provider_transaction_id, filtered.posted,
    filtered.balance_checkpoint_minor, filtered.adjustment_reason, count(*) over ()
  from filtered
  order by filtered.transaction_date desc, (filtered.transaction_type = 'balance_adjustment') desc, filtered.id
  limit greatest(1, least(p_limit, 1000)) offset greatest(0, p_offset);
$$;

revoke all on function public.list_workspace_transactions(uuid, integer, integer, text, uuid, uuid, uuid, boolean, date, date) from public;
grant execute on function public.list_workspace_transactions(uuid, integer, integer, text, uuid, uuid, uuid, boolean, date, date) to authenticated;

notify pgrst, 'reload schema';
commit;
