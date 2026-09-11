begin;

create table public.time_code_month_comments (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  time_code_id uuid not null,
  month_start date not null check (extract(day from month_start) = 1),
  comment text not null check (length(comment) <= 5000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, time_code_id, month_start),
  foreign key (workspace_id, time_code_id)
    references public.time_codes(workspace_id, id) on delete cascade
);

create trigger time_code_month_comments_set_updated_at
before update on public.time_code_month_comments
for each row execute function public.set_updated_at();

alter table public.time_code_month_comments enable row level security;

create policy time_code_month_comments_member_access on public.time_code_month_comments
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

create or replace function public.save_time_code_month_comment(
  p_workspace_id uuid,
  p_time_code_id uuid,
  p_month_start date,
  p_comment text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_comment text := btrim(coalesce(p_comment, ''));
begin
  if not public.is_workspace_member(p_workspace_id) then
    raise exception 'You do not have access to this workspace.' using errcode = '42501';
  end if;

  if extract(day from p_month_start) <> 1 then
    raise exception 'The comment month must start on the first day.' using errcode = '22007';
  end if;

  if length(normalized_comment) > 5000 then
    raise exception 'Comments cannot exceed 5,000 characters.' using errcode = '22001';
  end if;

  if not exists (
    select 1 from public.time_codes code
    where code.workspace_id = p_workspace_id and code.id = p_time_code_id
  ) then
    raise exception 'The time code no longer exists.' using errcode = '23503';
  end if;

  if normalized_comment = '' then
    delete from public.time_code_month_comments
    where workspace_id = p_workspace_id
      and time_code_id = p_time_code_id
      and month_start = p_month_start;
  else
    insert into public.time_code_month_comments (workspace_id, time_code_id, month_start, comment)
    values (p_workspace_id, p_time_code_id, p_month_start, normalized_comment)
    on conflict (workspace_id, time_code_id, month_start)
    do update set comment = excluded.comment;
  end if;
end;
$$;

revoke all on function public.save_time_code_month_comment(uuid, uuid, date, text) from public;
grant execute on function public.save_time_code_month_comment(uuid, uuid, date, text) to authenticated;

notify pgrst, 'reload schema';

commit;
