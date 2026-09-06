begin;

create table public.workspace_transaction_revisions (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  revision bigint not null default 1,
  updated_at timestamptz not null default now()
);

insert into public.workspace_transaction_revisions(workspace_id)
select workspace.id
from public.workspaces workspace
on conflict (workspace_id) do nothing;

alter table public.workspace_transaction_revisions enable row level security;

create policy workspace_transaction_revisions_member_read
  on public.workspace_transaction_revisions
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

create or replace function public.bump_workspace_transaction_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_workspace_id uuid := coalesce(new.workspace_id, old.workspace_id);
begin
  insert into public.workspace_transaction_revisions(workspace_id, revision, updated_at)
  values (target_workspace_id, 1, now())
  on conflict (workspace_id) do update
  set revision = public.workspace_transaction_revisions.revision + 1,
      updated_at = excluded.updated_at;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger transactions_bump_workspace_revision
after insert or update or delete on public.transactions
for each row execute function public.bump_workspace_transaction_revision();

create or replace function public.workspace_transaction_revision(p_workspace_id uuid)
returns bigint
language sql
stable
security invoker
set search_path = ''
as $$
  select revision.revision
  from public.workspace_transaction_revisions revision
  where revision.workspace_id = p_workspace_id;
$$;

revoke all on function public.bump_workspace_transaction_revision() from public;
revoke all on function public.workspace_transaction_revision(uuid) from public;
grant execute on function public.workspace_transaction_revision(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
