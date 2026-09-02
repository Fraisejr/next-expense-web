begin;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.workspaces (
  id uuid primary key,
  name text not null check (length(trim(name)) > 0),
  default_currency text not null default 'EUR' check (default_currency ~ '^[A-Z]{3}$'),
  import_timezone text not null default 'Europe/Paris',
  estimated_company_tax_rate_bps integer not null default 2000
    check (estimated_company_tax_rate_bps between 0 and 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Neon Auth IDs are text. Membership is deliberately separate from imported
-- financial records so an archive can be loaded before the first app sign-in.
create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id text not null,
  role text not null default 'owner' check (role in ('owner', 'member', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table public.accounts (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  account_type text not null check (account_type in ('Budget', 'External')),
  scope text not null default 'Personal' check (scope in ('Personal', 'Company')),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  sort_order integer not null default 0,
  closed boolean not null default false,
  investment boolean not null default false,
  pension boolean not null default false,
  auto_sync boolean not null default false,
  provider_account_id text,
  institution_id text,
  country text,
  last_refresh_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);

create table public.category_groups (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  sort_order integer not null default 0,
  show_categories boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);

create table public.categories (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  category_group_id uuid,
  name text not null check (length(trim(name)) > 0),
  category_type text not null check (category_type in ('Expense', 'Income', 'Investment')),
  color text,
  icon text,
  sort_order integer not null default 0,
  hidden boolean not null default false,
  default_budget_minor bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, category_group_id)
    references public.category_groups(workspace_id, id) on delete restrict
);

create table public.payees (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  sort_order integer not null default 0,
  show_on_watch boolean not null default false,
  transfer_payee boolean not null default false,
  default_account_id uuid,
  default_category_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, default_account_id)
    references public.accounts(workspace_id, id) on delete restrict,
  foreign key (workspace_id, default_category_id)
    references public.categories(workspace_id, id) on delete restrict
);

create table public.payee_mappings (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  normalized_name text not null check (length(trim(normalized_name)) > 0),
  source_name text not null check (length(trim(source_name)) > 0),
  payee_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, normalized_name),
  foreign key (workspace_id, payee_id)
    references public.payees(workspace_id, id) on delete cascade
);

create table public.periods (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  year integer not null check (year between 1900 and 2200),
  month integer not null check (month between 1 and 12),
  month_label text,
  period_start_date date not null,
  source_start_at timestamptz,
  show_transactions boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, year, month)
);

create table public.budgets (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  period_id uuid not null,
  category_id uuid not null,
  amount_minor bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, period_id)
    references public.periods(workspace_id, id) on delete restrict,
  foreign key (workspace_id, category_id)
    references public.categories(workspace_id, id) on delete restrict
);

create table public.fx_rates (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  period_id uuid not null,
  base_currency text not null check (base_currency ~ '^[A-Z]{3}$'),
  quote_currency text not null check (quote_currency ~ '^[A-Z]{3}$'),
  -- The iOS app stores rates in hundredths: 106 means 1.06.
  rate_hundredths integer not null check (rate_hundredths > 0),
  rate_date date not null,
  source_start_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, period_id)
    references public.periods(workspace_id, id) on delete restrict
);

create table public.transactions (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  account_id uuid,
  destination_account_id uuid,
  period_id uuid not null,
  category_id uuid,
  payee_id uuid,
  debtor_id uuid,
  transaction_date date not null,
  source_timestamp timestamptz not null,
  source_created_at timestamptz,
  amount_minor bigint not null,
  destination_amount_minor bigint not null default 0,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  transaction_type text not null check (transaction_type in ('expense', 'income', 'transfer')),
  payee_name text,
  memo text,
  provider_transaction_id text,
  posted boolean not null default false,
  reconciled boolean not null default false,
  recurring boolean not null default false,
  recurrence text,
  last_day_of_month boolean not null default false,
  expense_claim boolean not null default false,
  expense_invoiced boolean not null default false,
  expense_posted boolean not null default false,
  expense_settled boolean not null default false,
  source text not null default 'ios_import',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, account_id)
    references public.accounts(workspace_id, id) on delete restrict,
  foreign key (workspace_id, destination_account_id)
    references public.accounts(workspace_id, id) on delete restrict,
  foreign key (workspace_id, period_id)
    references public.periods(workspace_id, id) on delete restrict,
  foreign key (workspace_id, category_id)
    references public.categories(workspace_id, id) on delete restrict,
  foreign key (workspace_id, payee_id)
    references public.payees(workspace_id, id) on delete restrict,
  foreign key (workspace_id, debtor_id)
    references public.payees(workspace_id, id) on delete restrict
);

-- Only provider identifiers and connection state belong in Postgres. Provider
-- secrets and refresh credentials must stay in server-side secret storage.
create table public.bank_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider text not null,
  provider_connection_id text not null,
  institution_id text,
  status text not null default 'active'
    check (status in ('active', 'expired', 'revoked', 'error')),
  consent_expires_at timestamptz,
  last_synced_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, provider, provider_connection_id),
  unique (workspace_id, id)
);

create table public.import_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  archive_sha256 text not null check (archive_sha256 ~ '^[a-f0-9]{64}$'),
  source text not null,
  source_schema_version integer not null,
  source_exported_at timestamptz not null,
  import_timezone text not null,
  status text not null check (status in ('running', 'completed', 'failed')),
  source_counts jsonb not null default '{}'::jsonb,
  imported_counts jsonb not null default '{}'::jsonb,
  ignored_counts jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (workspace_id, archive_sha256)
);

create index accounts_workspace_idx on public.accounts(workspace_id);
create index categories_workspace_group_idx on public.categories(workspace_id, category_group_id);
create index payees_workspace_name_idx on public.payees(workspace_id, name);
create index budgets_workspace_period_idx on public.budgets(workspace_id, period_id);
create index fx_rates_workspace_period_idx on public.fx_rates(workspace_id, period_id);
create index transactions_workspace_date_idx on public.transactions(workspace_id, transaction_date desc);
create index transactions_workspace_account_date_idx
  on public.transactions(workspace_id, account_id, transaction_date desc);
create index transactions_provider_idx
  on public.transactions(workspace_id, account_id, provider_transaction_id)
  where provider_transaction_id is not null and provider_transaction_id <> '';

create trigger workspaces_set_updated_at before update on public.workspaces
  for each row execute function public.set_updated_at();
create trigger accounts_set_updated_at before update on public.accounts
  for each row execute function public.set_updated_at();
create trigger category_groups_set_updated_at before update on public.category_groups
  for each row execute function public.set_updated_at();
create trigger categories_set_updated_at before update on public.categories
  for each row execute function public.set_updated_at();
create trigger payees_set_updated_at before update on public.payees
  for each row execute function public.set_updated_at();
create trigger payee_mappings_set_updated_at before update on public.payee_mappings
  for each row execute function public.set_updated_at();
create trigger periods_set_updated_at before update on public.periods
  for each row execute function public.set_updated_at();
create trigger budgets_set_updated_at before update on public.budgets
  for each row execute function public.set_updated_at();
create trigger fx_rates_set_updated_at before update on public.fx_rates
  for each row execute function public.set_updated_at();
create trigger transactions_set_updated_at before update on public.transactions
  for each row execute function public.set_updated_at();
create trigger bank_connections_set_updated_at before update on public.bank_connections
  for each row execute function public.set_updated_at();

-- RLS is enabled before any client-facing Data API is provisioned. With no
-- policies yet, browser clients are denied by default. A follow-up migration
-- adds membership policies once Neon installs auth.user_id().
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.accounts enable row level security;
alter table public.category_groups enable row level security;
alter table public.categories enable row level security;
alter table public.payees enable row level security;
alter table public.payee_mappings enable row level security;
alter table public.periods enable row level security;
alter table public.budgets enable row level security;
alter table public.fx_rates enable row level security;
alter table public.transactions enable row level security;
alter table public.bank_connections enable row level security;
alter table public.import_runs enable row level security;

commit;
