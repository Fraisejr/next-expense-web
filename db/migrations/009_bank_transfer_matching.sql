begin;

create table public.bank_account_aliases (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  account_id uuid not null,
  provider text not null default 'gocardless_bank_account_data',
  alias text not null check (length(btrim(alias)) > 0),
  normalized_alias text not null check (length(btrim(normalized_alias)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, provider, normalized_alias),
  foreign key (workspace_id, account_id)
    references public.accounts(workspace_id, id) on delete cascade
);

create table public.bank_transaction_refs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  transaction_id uuid not null,
  account_id uuid not null,
  provider text not null,
  provider_transaction_id text,
  bank_transaction_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    nullif(btrim(provider_transaction_id), '') is not null
    or nullif(btrim(bank_transaction_id), '') is not null
  ),
  foreign key (workspace_id, transaction_id)
    references public.transactions(workspace_id, id) on delete cascade,
  foreign key (workspace_id, account_id)
    references public.accounts(workspace_id, id) on delete cascade
);

create unique index bank_transaction_refs_provider_id_idx
  on public.bank_transaction_refs(workspace_id, provider, account_id, provider_transaction_id)
  where provider_transaction_id is not null and provider_transaction_id <> '';

create unique index bank_transaction_refs_bank_id_idx
  on public.bank_transaction_refs(workspace_id, provider, account_id, bank_transaction_id)
  where bank_transaction_id is not null and bank_transaction_id <> '';

create index bank_transaction_refs_transaction_idx
  on public.bank_transaction_refs(workspace_id, transaction_id);

create trigger bank_account_aliases_set_updated_at
  before update on public.bank_account_aliases
  for each row execute function public.set_updated_at();

create trigger bank_transaction_refs_set_updated_at
  before update on public.bank_transaction_refs
  for each row execute function public.set_updated_at();

alter table public.bank_account_aliases enable row level security;
alter table public.bank_transaction_refs enable row level security;

create policy bank_account_aliases_member_access on public.bank_account_aliases
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

create policy bank_transaction_refs_member_access on public.bank_transaction_refs
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

grant select, insert, update, delete on public.bank_account_aliases to authenticated;
grant select, insert, update, delete on public.bank_transaction_refs to authenticated;

commit;
