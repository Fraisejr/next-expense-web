begin;

create table public.time_codes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  sort_order integer not null default 0,
  hidden_from_month date check (hidden_from_month is null or extract(day from hidden_from_month) = 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, name)
);

create table public.time_entries (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  time_code_id uuid not null,
  work_date date not null,
  hours smallint not null check (hours > 0 and hours <= 24),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, time_code_id, work_date),
  foreign key (workspace_id, time_code_id)
    references public.time_codes(workspace_id, id) on delete cascade
);

create index time_entries_workspace_date_idx
  on public.time_entries(workspace_id, work_date);

create trigger time_codes_set_updated_at
before update on public.time_codes
for each row execute function public.set_updated_at();

create trigger time_entries_set_updated_at
before update on public.time_entries
for each row execute function public.set_updated_at();

alter table public.time_codes enable row level security;
alter table public.time_entries enable row level security;

create policy time_codes_member_access on public.time_codes
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

create policy time_entries_member_access on public.time_entries
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

notify pgrst, 'reload schema';

commit;
