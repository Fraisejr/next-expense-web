begin;

-- Check membership and read both tables in the same authenticated request.
-- Missing user context must be an error, never an apparently empty timesheet.
create or replace function public.read_timesheet(
  p_workspace_id uuid,
  p_start_date date,
  p_end_date date,
  p_comment_month date default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if not public.is_workspace_member(p_workspace_id) then
    raise exception 'You do not have access to this workspace.' using errcode = '42501';
  end if;
  if p_start_date is null or p_end_date is null or p_end_date <= p_start_date
    or p_end_date > p_start_date + interval '1 year' then
    raise exception 'Invalid timesheet date range.' using errcode = '22007';
  end if;
  if p_comment_month is not null and extract(day from p_comment_month) <> 1 then
    raise exception 'Invalid timesheet comment month.' using errcode = '22007';
  end if;
  return jsonb_build_object(
    'workspaceId', p_workspace_id,
    'entries', coalesce((select jsonb_agg(jsonb_build_object(
      'time_code_id', time_code_id, 'work_date', work_date, 'hours', hours
    ) order by work_date, time_code_id) from public.time_entries
      where workspace_id = p_workspace_id and work_date >= p_start_date and work_date < p_end_date), '[]'::jsonb),
    'comments', coalesce((select jsonb_agg(jsonb_build_object(
      'time_code_id', time_code_id, 'month_start', month_start, 'comment', comment
    ) order by time_code_id) from public.time_code_month_comments
      where workspace_id = p_workspace_id and month_start = p_comment_month), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.read_timesheet(uuid, date, date, date) from public;
grant execute on function public.read_timesheet(uuid, date, date, date) to authenticated;
notify pgrst, 'reload schema';
commit;
