begin;

alter table public.bank_import_candidates
  add column category_id uuid;

alter table public.bank_import_candidates
  add constraint bank_import_candidates_category_fk
  foreign key (workspace_id, category_id)
  references public.categories(workspace_id, id) on delete restrict;

update public.bank_import_candidates candidate
set category_id = payee.default_category_id
from public.payees payee
where candidate.workspace_id = payee.workspace_id
  and candidate.payee_id = payee.id
  and candidate.category_id is null
  and payee.default_category_id is not null;

-- Preserve all historical transaction data exactly as imported. NOT VALID
-- skips the historical scan while still enforcing the rule for new rows.
alter table public.transactions
  add constraint transactions_category_by_type_check
  check (
    (transaction_type = 'transfer' and category_id is null)
    or (transaction_type <> 'transfer' and category_id is not null)
  ) not valid;

drop function if exists public.approve_bank_import_candidate(uuid, uuid);

create function public.approve_bank_import_candidate(
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
  target_period_id uuid;
  created_transaction_id uuid;
begin
  select * into candidate
  from public.bank_import_candidates
  where workspace_id = p_workspace_id and id = p_candidate_id
  for update;

  if candidate.id is null then
    raise exception 'The bank transaction awaiting review no longer exists.';
  end if;
  if candidate.status = 'approved' and candidate.transaction_id is not null then
    return candidate.transaction_id;
  end if;
  if candidate.status <> 'pending' then
    raise exception 'Only pending bank transactions can be approved.';
  end if;
  if not exists (
    select 1 from public.categories
    where workspace_id = p_workspace_id and id = p_category_id and not hidden
  ) then
    raise exception 'Choose an active category before approving this transaction.';
  end if;

  select id into target_period_id
  from public.periods
  where workspace_id = p_workspace_id
    and year = extract(year from candidate.transaction_date)::integer
    and month = extract(month from candidate.transaction_date)::integer;

  if target_period_id is null then
    target_period_id := gen_random_uuid();
    insert into public.periods (
      id, workspace_id, year, month, month_label, period_start_date, source_start_at
    ) values (
      target_period_id,
      p_workspace_id,
      extract(year from candidate.transaction_date)::integer,
      extract(month from candidate.transaction_date)::integer,
      to_char(candidate.transaction_date, 'YYYY-MM'),
      date_trunc('month', candidate.transaction_date)::date,
      date_trunc('month', candidate.transaction_date)::timestamptz
    );
  end if;

  created_transaction_id := gen_random_uuid();
  insert into public.transactions (
    id, workspace_id, account_id, period_id, category_id, payee_id,
    transaction_date, source_timestamp, source_created_at,
    amount_minor, destination_amount_minor, currency, transaction_type,
    payee_name, memo, provider_transaction_id, bank_transaction_id,
    posted, reconciled, source
  ) values (
    created_transaction_id, p_workspace_id, candidate.account_id, target_period_id, p_category_id, candidate.payee_id,
    candidate.transaction_date, (candidate.transaction_date::text || 'T12:00:00Z')::timestamptz, candidate.fetched_at,
    candidate.amount_minor, 0, candidate.currency, candidate.transaction_type,
    candidate.payee_name, candidate.memo, candidate.provider_transaction_id, candidate.bank_transaction_id,
    candidate.posted, candidate.posted, 'gocardless'
  );

  insert into public.bank_transaction_refs (
    workspace_id, transaction_id, account_id, provider,
    provider_transaction_id, bank_transaction_id
  ) values (
    p_workspace_id, created_transaction_id, candidate.account_id, candidate.provider,
    candidate.provider_transaction_id, candidate.bank_transaction_id
  ) on conflict do nothing;

  update public.bank_import_candidates
  set status = 'approved', category_id = p_category_id,
      transaction_id = created_transaction_id, decided_at = now()
  where workspace_id = p_workspace_id and id = candidate.id;

  if p_remember_category and candidate.payee_id is not null then
    update public.payees
    set default_category_id = p_category_id
    where workspace_id = p_workspace_id and id = candidate.payee_id;
  end if;

  return created_transaction_id;
end;
$$;

revoke all on function public.approve_bank_import_candidate(uuid, uuid, uuid, boolean) from public;
grant execute on function public.approve_bank_import_candidate(uuid, uuid, uuid, boolean) to authenticated;

commit;
