begin;

alter table public.accounts
  add column bank_import_mode text not null default 'review'
    check (bank_import_mode in ('review', 'automatic'));

create table public.bank_import_candidates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  account_id uuid not null,
  provider text not null,
  provider_transaction_id text,
  bank_transaction_id text,
  transaction_date date not null,
  amount_minor bigint not null check (amount_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  transaction_type text not null check (transaction_type in ('expense', 'income')),
  payee_id uuid,
  payee_name text not null,
  memo text,
  posted boolean not null default true,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'matched')),
  transaction_id uuid,
  fetched_at timestamptz not null,
  raw_payload jsonb,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    nullif(btrim(provider_transaction_id), '') is not null
    or nullif(btrim(bank_transaction_id), '') is not null
  ),
  foreign key (workspace_id, account_id)
    references public.accounts(workspace_id, id) on delete cascade,
  foreign key (payee_id)
    references public.payees(id) on delete set null,
  foreign key (transaction_id)
    references public.transactions(id) on delete set null
);

create unique index bank_import_candidates_provider_id_idx
  on public.bank_import_candidates(workspace_id, provider, account_id, provider_transaction_id)
  where provider_transaction_id is not null and provider_transaction_id <> '';

create unique index bank_import_candidates_bank_id_idx
  on public.bank_import_candidates(workspace_id, provider, account_id, bank_transaction_id)
  where bank_transaction_id is not null and bank_transaction_id <> '';

create index bank_import_candidates_review_idx
  on public.bank_import_candidates(workspace_id, account_id, status, transaction_date desc);

create trigger bank_import_candidates_set_updated_at
  before update on public.bank_import_candidates
  for each row execute function public.set_updated_at();

alter table public.bank_import_candidates enable row level security;

create policy bank_import_candidates_member_access on public.bank_import_candidates
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

grant select, insert, update, delete on public.bank_import_candidates to authenticated;

create or replace function public.approve_bank_import_candidate(
  p_workspace_id uuid,
  p_candidate_id uuid
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
    id, workspace_id, account_id, period_id, payee_id,
    transaction_date, source_timestamp, source_created_at,
    amount_minor, destination_amount_minor, currency, transaction_type,
    payee_name, memo, provider_transaction_id, bank_transaction_id,
    posted, reconciled, source
  ) values (
    created_transaction_id, p_workspace_id, candidate.account_id, target_period_id, candidate.payee_id,
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
  set status = 'approved', transaction_id = created_transaction_id, decided_at = now()
  where workspace_id = p_workspace_id and id = candidate.id;

  return created_transaction_id;
end;
$$;

revoke all on function public.approve_bank_import_candidate(uuid, uuid) from public;
grant execute on function public.approve_bank_import_candidate(uuid, uuid) to authenticated;

commit;
