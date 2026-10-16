begin;

-- Store destination labels separately from the user's short source labels.
alter table public.time_codes
  add column kleer_project text,
  add column kleer_activity text,
  add constraint time_codes_kleer_mapping_complete check (
    (kleer_project is null and kleer_activity is null) or
    (kleer_project is not null and kleer_activity is not null
      and length(btrim(kleer_project)) between 1 and 500
      and length(btrim(kleer_activity)) between 1 and 200)
  );

-- Private read-only entry point: keep the runtime unable to read tables directly.
create function expense_mcp.read_timesheet(p_access_hash text,p_tool text,p_args jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  v_workspace uuid;
  v_scope text;
  v_start date;
  v_end date;
  v_client uuid := (p_args->>'client_id')::uuid;
  v_code uuid := (p_args->>'time_code_id')::uuid;
  v_limit integer := coalesce((p_args->>'limit')::integer,100);
  v_offset integer := coalesce((p_args->>'offset')::integer,0);
  v_result jsonb;
begin
  select g.workspace_id,g.scope into v_workspace,v_scope
  from expense_mcp.grants g join public.workspace_members m
    on m.workspace_id=g.workspace_id and m.user_id=g.user_id
  where g.access_hash=p_access_hash and g.revoked_at is null and g.access_expires_at>now();
  if v_workspace is null then raise exception 'Connection expired or workspace access was removed. Reconnect your account.' using errcode='42501'; end if;
  if not ('expenses:read'=any(string_to_array(v_scope,' '))) then raise exception 'Read permission required.' using errcode='42501'; end if;
  if v_limit not between 1 and 100 or v_offset not between 0 and 100000 then raise exception 'Invalid pagination.' using errcode='22023'; end if;
  if v_client is not null and not exists(select 1 from public.timesheet_clients c where c.workspace_id=v_workspace and c.id=v_client) then raise exception 'Client is not in the connected workspace.' using errcode='22023'; end if;
  if v_code is not null and not exists(select 1 from public.time_codes c where c.workspace_id=v_workspace and c.id=v_code) then raise exception 'Time code is not in the connected workspace.' using errcode='22023'; end if;

  if p_tool='list_time_codes' then
    with codes as materialized (
      select c.id as time_code_id,c.name as time_code_name,c.hidden_from_month,c.client_id,
        cl.name as client_name,cl.active as client_active,case when c.kleer_project is not null then jsonb_build_object('system','kleer','project',c.kleer_project,'activity',c.kleer_activity) end as reporting_mapping,c.sort_order
      from public.time_codes c left join public.timesheet_clients cl on cl.workspace_id=c.workspace_id and cl.id=c.client_id
      where c.workspace_id=v_workspace and (v_client is null or c.client_id=v_client)
    ), page as (select * from codes order by sort_order,time_code_id limit v_limit offset v_offset)
    select jsonb_build_object('workspace_id',v_workspace,'items',coalesce((select jsonb_agg(to_jsonb(p)-'sort_order' order by p.sort_order,p.time_code_id) from page p),'[]'::jsonb),
      'total_codes',(select count(*) from codes),'limit',v_limit,'offset',v_offset,
      'next_offset',case when v_offset+(select count(*) from page)<(select count(*) from codes) then v_offset+v_limit end) into v_result;
    return v_result;
  end if;
  if p_tool<>'read_timesheet' or p_tool is null then raise exception 'Unknown timesheet tool.' using errcode='22023'; end if;
  v_start:=(p_args->>'start_date')::date;
  v_end:=(p_args->>'end_date')::date;
  if v_start is null or v_end is null or v_start<date '1900-01-01' or v_end>date '2200-12-31' or v_end<v_start or v_end-v_start>365 then
    raise exception 'Use an inclusive date range of at most 366 days between 1900 and 2200.' using errcode='22007';
  end if;
  with entries as materialized (
    select v_workspace::text||':'||e.time_code_id::text||':'||e.work_date::text as entry_key,
      e.work_date,e.time_code_id,c.name as time_code_name,c.client_id,cl.name as client_name,cl.active as client_active,
      case when c.kleer_project is not null then jsonb_build_object('system','kleer','project',c.kleer_project,'activity',c.kleer_activity) end as reporting_mapping,
      e.hours,e.hours::integer*60 as minutes,e.updated_at,date_trunc('month',e.work_date)::date as comment_month,mc.comment as month_comment
    from public.time_entries e
    join public.time_codes c on c.workspace_id=e.workspace_id and c.id=e.time_code_id
    left join public.timesheet_clients cl on cl.workspace_id=c.workspace_id and cl.id=c.client_id
    left join public.time_code_month_comments mc on mc.workspace_id=e.workspace_id and mc.time_code_id=e.time_code_id and mc.month_start=date_trunc('month',e.work_date)::date
    where e.workspace_id=v_workspace and e.work_date between v_start and v_end
      and (v_client is null or c.client_id=v_client) and (v_code is null or e.time_code_id=v_code)
  ), page as (select * from entries order by work_date,time_code_id limit v_limit offset v_offset), totals as (
    select count(*) as count,coalesce(sum(hours),0) as hours,
      count(*) filter(where reporting_mapping is null) as unmapped_entries,
      md5(coalesce(string_agg(md5(to_jsonb(e)::text),'' order by work_date,time_code_id),'')) as revision from entries e
  )
  select jsonb_build_object('workspace_id',v_workspace,'start_date',v_start,'end_date',v_end,
    'entries',coalesce((select jsonb_agg(to_jsonb(p) order by p.work_date,p.time_code_id) from page p),'[]'::jsonb),
    'unmapped_entries',t.unmapped_entries,'total_entries',t.count,'total_hours',t.hours,'total_minutes',t.hours*60,'revision',t.revision,
    'limit',v_limit,'offset',v_offset,'next_offset',case when v_offset+(select count(*) from page)<t.count then v_offset+v_limit end)
  into v_result from totals t;
  if p_args->>'revision' is not null and p_args->>'revision'<>v_result->>'revision' then
    raise exception 'Timesheet changed during paging. Restart from offset 0.' using errcode='40001';
  end if;
  return v_result;
end $$;
revoke all on function expense_mcp.read_timesheet(text,text,jsonb) from public;
grant execute on function expense_mcp.read_timesheet(text,text,jsonb) to expense_mcp_runtime;
commit;
