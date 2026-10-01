begin;

create table public.workspace_snapshot_revisions (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  revision bigint not null default 1,
  updated_at timestamptz not null default now()
);

insert into public.workspace_snapshot_revisions(workspace_id)
select id from public.workspaces
on conflict (workspace_id) do nothing;

alter table public.workspace_snapshot_revisions enable row level security;
create policy workspace_snapshot_revisions_member_read
  on public.workspace_snapshot_revisions for select to authenticated
  using (public.is_workspace_member(workspace_id));
grant select on public.workspace_snapshot_revisions to authenticated;

create function public.bump_workspace_snapshot_revision()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    insert into public.workspace_snapshot_revisions(workspace_id, revision, updated_at)
    select distinct workspace_id, 1, now() from new_rows
    on conflict (workspace_id) do update
      set revision = public.workspace_snapshot_revisions.revision + 1,
          updated_at = excluded.updated_at;
  elsif tg_op = 'DELETE' then
    insert into public.workspace_snapshot_revisions(workspace_id, revision, updated_at)
    select distinct old_rows.workspace_id, 1, now() from old_rows
    join public.workspaces workspace on workspace.id = old_rows.workspace_id
    on conflict (workspace_id) do update
      set revision = public.workspace_snapshot_revisions.revision + 1,
          updated_at = excluded.updated_at;
  else
    insert into public.workspace_snapshot_revisions(workspace_id, revision, updated_at)
    select distinct workspace_id, 1, now()
    from (select workspace_id from old_rows union select workspace_id from new_rows) changed
    on conflict (workspace_id) do update
      set revision = public.workspace_snapshot_revisions.revision + 1,
          updated_at = excluded.updated_at;
  end if;
  return null;
end;
$$;

-- Transition tables let bulk syncs and restores bump each affected workspace once.
do $$
declare table_name text;
begin
  foreach table_name in array array[
    'workspace_members', 'accounts', 'category_groups', 'categories',
    'periods', 'budgets', 'fx_rates', 'payees', 'payee_mappings',
    'timesheet_clients', 'timesheet_client_rates', 'timesheet_client_forecasts',
    'time_codes', 'transactions', 'bank_connections', 'bank_import_candidates'
  ] loop
    execute format('create trigger %I after insert on public.%I referencing new table as new_rows for each statement execute function public.bump_workspace_snapshot_revision()', table_name || '_snapshot_insert', table_name);
    execute format('create trigger %I after update on public.%I referencing old table as old_rows new table as new_rows for each statement execute function public.bump_workspace_snapshot_revision()', table_name || '_snapshot_update', table_name);
    execute format('create trigger %I after delete on public.%I referencing old table as old_rows for each statement execute function public.bump_workspace_snapshot_revision()', table_name || '_snapshot_delete', table_name);
  end loop;
end;
$$;

create function public.bump_workspace_row_snapshot_revision()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.workspace_snapshot_revisions(workspace_id, revision, updated_at)
  values (new.id, 1, now())
  on conflict (workspace_id) do update
    set revision = public.workspace_snapshot_revisions.revision + 1,
        updated_at = excluded.updated_at;
  return new;
end;
$$;

create trigger workspaces_snapshot_insert_update
after insert or update on public.workspaces
for each row execute function public.bump_workspace_row_snapshot_revision();

create function public.workspace_snapshot_revision(p_workspace_id uuid)
returns bigint language sql stable security invoker set search_path = '' as $$
  select revision.revision from public.workspace_snapshot_revisions revision
  where revision.workspace_id = p_workspace_id;
$$;

revoke all on function public.bump_workspace_snapshot_revision() from public;
revoke all on function public.bump_workspace_row_snapshot_revision() from public;
revoke all on function public.workspace_snapshot_revision(uuid) from public;
grant execute on function public.workspace_snapshot_revision(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
