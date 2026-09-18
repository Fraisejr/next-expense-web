begin;

create table public.timesheet_clients (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, name)
);

create table public.timesheet_client_rates (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  client_id uuid not null,
  effective_from date not null,
  hourly_rate_minor bigint not null check (hourly_rate_minor >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, client_id, effective_from),
  foreign key (workspace_id, client_id)
    references public.timesheet_clients(workspace_id, id) on delete cascade
);

create table public.timesheet_client_forecasts (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  client_id uuid not null,
  forecast_year integer not null check (forecast_year between 2000 and 2200),
  weekly_hours numeric(6, 2) not null default 0 check (weekly_hours >= 0 and weekly_hours <= 168),
  vacation_weeks numeric(5, 2) not null default 0 check (vacation_weeks >= 0 and vacation_weeks <= 53),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, client_id, forecast_year),
  foreign key (workspace_id, client_id)
    references public.timesheet_clients(workspace_id, id) on delete cascade
);

alter table public.time_codes
  add column client_id uuid,
  add constraint time_codes_client_fk
    foreign key (workspace_id, client_id)
    references public.timesheet_clients(workspace_id, id) on delete set null (client_id);

create index timesheet_clients_workspace_order_idx
  on public.timesheet_clients(workspace_id, sort_order, name);

create index timesheet_client_rates_lookup_idx
  on public.timesheet_client_rates(workspace_id, client_id, effective_from desc);

create trigger timesheet_clients_set_updated_at
before update on public.timesheet_clients
for each row execute function public.set_updated_at();

create trigger timesheet_client_rates_set_updated_at
before update on public.timesheet_client_rates
for each row execute function public.set_updated_at();

create trigger timesheet_client_forecasts_set_updated_at
before update on public.timesheet_client_forecasts
for each row execute function public.set_updated_at();

alter table public.timesheet_clients enable row level security;
alter table public.timesheet_client_rates enable row level security;
alter table public.timesheet_client_forecasts enable row level security;

create policy timesheet_clients_member_access on public.timesheet_clients
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

create policy timesheet_client_rates_member_access on public.timesheet_client_rates
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

create policy timesheet_client_forecasts_member_access on public.timesheet_client_forecasts
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

create or replace function public.create_timesheet_client(
  p_workspace_id uuid,
  p_client_id uuid,
  p_name text,
  p_currency text,
  p_sort_order integer,
  p_effective_from date,
  p_hourly_rate_minor bigint
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_workspace_member(p_workspace_id) then
    raise exception 'You do not have access to this workspace.' using errcode = '42501';
  end if;

  insert into public.timesheet_clients (id, workspace_id, name, currency, sort_order)
  values (p_client_id, p_workspace_id, btrim(p_name), upper(p_currency), p_sort_order);

  insert into public.timesheet_client_rates (workspace_id, client_id, effective_from, hourly_rate_minor)
  values (p_workspace_id, p_client_id, p_effective_from, p_hourly_rate_minor);
end;
$$;

revoke all on function public.create_timesheet_client(uuid, uuid, text, text, integer, date, bigint) from public;
grant execute on function public.create_timesheet_client(uuid, uuid, text, text, integer, date, bigint) to authenticated;

notify pgrst, 'reload schema';

commit;
