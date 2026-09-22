begin;

create table public.bank_sync_cron_runs (
  id uuid primary key,
  run_date date not null,
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed')),
  phase text not null default 'received'
    check (phase in ('received', 'authenticating', 'authenticated', 'enumerated', 'syncing', 'completed', 'failed')),
  dry_run boolean not null default false,
  workspace_ids uuid[] not null default '{}'::uuid[],
  eligible_count integer,
  attempted_count integer not null default 0,
  completed_count integer not null default 0,
  failed_count integer not null default 0,
  skipped_count integer not null default 0,
  account_results jsonb not null default '[]'::jsonb,
  error_message text,
  response_status integer,
  deployment_id text,
  deployment_url text,
  git_commit_sha text,
  request_id text,
  user_agent text,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index bank_sync_cron_runs_started_idx
  on public.bank_sync_cron_runs(started_at desc);

create index bank_sync_cron_runs_workspace_ids_idx
  on public.bank_sync_cron_runs using gin(workspace_ids);

create trigger bank_sync_cron_runs_set_updated_at
before update on public.bank_sync_cron_runs
for each row execute function public.set_updated_at();

alter table public.bank_sync_cron_runs enable row level security;

create policy bank_sync_cron_runs_member_read on public.bank_sync_cron_runs
  for select to authenticated
  using (
    exists (
      select 1
      from public.workspace_members member
      where member.user_id = auth.user_id()::text
        and member.workspace_id = any(bank_sync_cron_runs.workspace_ids)
    )
  );

grant select on public.bank_sync_cron_runs to authenticated;

notify pgrst, 'reload schema';

commit;
