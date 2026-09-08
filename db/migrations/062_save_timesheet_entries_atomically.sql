begin;

create or replace function public.save_time_entry(
  p_workspace_id uuid,
  p_time_code_id uuid,
  p_work_date date,
  p_hours integer
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

  if p_hours < 0 or p_hours > 24 then
    raise exception 'Hours must be a whole number between 0 and 24.' using errcode = '22003';
  end if;

  if not exists (
    select 1
    from public.time_codes code
    where code.workspace_id = p_workspace_id
      and code.id = p_time_code_id
  ) then
    raise exception 'The time code no longer exists.' using errcode = '23503';
  end if;

  if p_hours = 0 then
    delete from public.time_entries
    where workspace_id = p_workspace_id
      and time_code_id = p_time_code_id
      and work_date = p_work_date;
  else
    insert into public.time_entries (workspace_id, time_code_id, work_date, hours)
    values (p_workspace_id, p_time_code_id, p_work_date, p_hours)
    on conflict (workspace_id, time_code_id, work_date)
    do update set hours = excluded.hours;
  end if;
end;
$$;

revoke all on function public.save_time_entry(uuid, uuid, date, integer) from public;
grant execute on function public.save_time_entry(uuid, uuid, date, integer) to authenticated;

notify pgrst, 'reload schema';

commit;
