begin;

create or replace function public.match_bank_import_candidate_to_existing_transfer(
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
  matched_transaction_id uuid;
begin
  select * into candidate
  from public.bank_import_candidates
  where workspace_id = p_workspace_id and id = p_candidate_id
  for update;

  if candidate.id is null then
    raise exception 'The bank transaction awaiting review no longer exists.';
  end if;
  if candidate.status <> 'pending' then
    return candidate.transaction_id;
  end if;

  with possible_matches as (
    select
      ledger_transaction.id,
      abs(ledger_transaction.transaction_date - candidate.transaction_date) as day_distance
    from public.transactions ledger_transaction
    where ledger_transaction.workspace_id = p_workspace_id
      and ledger_transaction.transaction_type = 'transfer'
      and ledger_transaction.currency = candidate.currency
      and abs(ledger_transaction.transaction_date - candidate.transaction_date) <= 3
      and (
        (candidate.transaction_type = 'expense'
          and ledger_transaction.account_id = candidate.account_id
          and ledger_transaction.destination_account_id = p_counterparty_account_id
          and ledger_transaction.amount_minor = candidate.amount_minor)
        or
        (candidate.transaction_type = 'income'
          and ledger_transaction.destination_account_id = candidate.account_id
          and ledger_transaction.account_id = p_counterparty_account_id
          and coalesce(ledger_transaction.destination_amount_minor, ledger_transaction.amount_minor) = candidate.amount_minor)
      )
      and not exists (
        select 1
        from public.bank_transaction_refs reference
        where reference.workspace_id = p_workspace_id
          and reference.transaction_id = ledger_transaction.id
          and reference.account_id = candidate.account_id
      )
  ), closest_matches as (
    select id
    from possible_matches
    where day_distance = (select min(day_distance) from possible_matches)
  )
  select case when count(*) = 1 then (array_agg(id))[1] end
  into matched_transaction_id
  from closest_matches;

  if matched_transaction_id is null then
    return null;
  end if;

  insert into public.bank_transaction_refs (
    workspace_id, transaction_id, account_id, provider,
    provider_transaction_id, bank_transaction_id
  ) values (
    p_workspace_id, matched_transaction_id, candidate.account_id, candidate.provider,
    candidate.provider_transaction_id, candidate.bank_transaction_id
  ) on conflict do nothing;

  update public.bank_import_candidates
  set status = 'matched',
      category_id = null,
      payee_id = null,
      transaction_id = matched_transaction_id,
      decided_at = pg_catalog.now()
  where workspace_id = p_workspace_id and id = candidate.id;

  return matched_transaction_id;
end;
$$;

revoke all on function public.match_bank_import_candidate_to_existing_transfer(uuid, uuid, uuid) from public;
grant execute on function public.match_bank_import_candidate_to_existing_transfer(uuid, uuid, uuid) to authenticated;

alter function public.approve_bank_import_candidate_as_transfer(uuid, uuid, uuid)
  rename to create_bank_import_transfer_from_candidate;

create function public.approve_bank_import_candidate_as_transfer(
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
  matched_transaction_id uuid;
begin
  matched_transaction_id := public.match_bank_import_candidate_to_existing_transfer(
    p_workspace_id,
    p_candidate_id,
    p_counterparty_account_id
  );

  if matched_transaction_id is not null then
    return matched_transaction_id;
  end if;

  return public.create_bank_import_transfer_from_candidate(
    p_workspace_id,
    p_candidate_id,
    p_counterparty_account_id
  );
end;
$$;

revoke all on function public.create_bank_import_transfer_from_candidate(uuid, uuid, uuid) from public;
grant execute on function public.create_bank_import_transfer_from_candidate(uuid, uuid, uuid) to authenticated;
revoke all on function public.approve_bank_import_candidate_as_transfer(uuid, uuid, uuid) from public;
grant execute on function public.approve_bank_import_candidate_as_transfer(uuid, uuid, uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
