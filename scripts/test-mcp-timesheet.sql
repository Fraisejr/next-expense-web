-- Disposable local DB only; schema through timesheet migrations 060/064/066,
-- private MCP schema 074, and migration 076. Fixtures roll back.
begin;
insert into public.workspaces(id,name) values('10000000-0000-4000-8000-000000000001','Timesheet fixture'),('10000000-0000-4000-8000-000000000002','Other workspace');
insert into public.workspace_members(workspace_id,user_id,role) values('10000000-0000-4000-8000-000000000001','timesheet-reader','viewer');
insert into public.timesheet_clients(id,workspace_id,name,currency,active) values
('60000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Current','EUR',true),
('60000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','Archived','EUR',false),
('60000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000002','Private','EUR',true);
insert into public.time_codes(id,workspace_id,name,client_id,hidden_from_month) values
('70000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Project A','60000000-0000-4000-8000-000000000001',null),
('70000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','Hidden B','60000000-0000-4000-8000-000000000002','2026-10-01'),
('70000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','Legacy',null,null),
('70000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000002','Private code','60000000-0000-4000-8000-000000000003',null);
update public.time_codes set kleer_project='Exact project label',kleer_activity='Konsulttid' where id='70000000-0000-4000-8000-000000000001';
insert into public.time_entries(workspace_id,time_code_id,work_date,hours) values
('10000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001','2026-09-30',1),
('10000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001','2026-10-01',2),
('10000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000002','2026-10-01',3),
('10000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001','2026-10-02',5),
('10000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000003','2026-10-03',1),
('10000000-0000-4000-8000-000000000002','70000000-0000-4000-8000-000000000004','2026-10-01',24);
insert into public.time_code_month_comments(workspace_id,time_code_id,month_start,comment) values
('10000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001','2026-09-01','September note'),
('10000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001','2026-10-01','Monthly note');
insert into expense_mcp.grants(id,user_id,workspace_id,client_id,client_name,resource,scope,access_hash,refresh_hash,access_expires_at,refresh_expires_at)
values(gen_random_uuid(),'timesheet-reader','10000000-0000-4000-8000-000000000001','client','Test','https://example.com/api/mcp','expenses:read','timesheet-access','timesheet-refresh',now()+interval '1 hour',now()+interval '1 day');
set local role expense_mcp_runtime;
do $$
declare
  args jsonb := '{"start_date":"2026-10-01","end_date":"2026-10-03","limit":2}';
  result jsonb;
  next_page jsonb;
  revision text;
begin
  result:=expense_mcp.read_timesheet('timesheet-access','list_time_codes','{}');
  assert result->>'total_codes'='3','Must include hidden and unassigned codes, exclude other workspaces';
  result:=expense_mcp.read_timesheet('timesheet-access','read_timesheet',args);
  assert result->>'unmapped_entries'='2','Unmapped entries must be explicit';
  assert result->'entries'->0->'reporting_mapping'->>'project'='Exact project label' and result->'entries'->0->'reporting_mapping'->>'activity'='Konsulttid','Exact saved mapping accompanies hours';
  assert result->>'total_hours'='11' and result->>'total_minutes'='660' and result->>'total_entries'='4','Full range totals must include hidden/inactive/legacy work';
  assert jsonb_array_length(result->'entries')=2 and result->>'next_offset'='2','First page must be bounded';
  assert result->'entries'->0->>'work_date'='2026-10-01' and result->'entries'->0->>'minutes'='120','Dates and minutes must be exact';
  assert result->'entries'->0->>'month_comment'='Monthly note','Comment must belong to entry month';
  assert result->'entries'->0->>'entry_key'='10000000-0000-4000-8000-000000000001:70000000-0000-4000-8000-000000000001:2026-10-01','Stable identity for reconciliation';
  assert result->'entries'->1->>'client_active'='false','Inactive client history remains readable';
  revision:=result->>'revision';
  next_page:=expense_mcp.read_timesheet('timesheet-access','read_timesheet',args||jsonb_build_object('offset',2,'revision',revision));
  assert jsonb_array_length(next_page->'entries')=2 and next_page->'next_offset'='null'::jsonb,'Last page must be explicit';
  assert next_page->>'total_hours'='11','Totals are full range, not page totals';
  result:=expense_mcp.read_timesheet('timesheet-access','read_timesheet',args||'{"client_id":"60000000-0000-4000-8000-000000000001"}');
  assert result->>'total_hours'='7','Client filter';
  result:=expense_mcp.read_timesheet('timesheet-access','read_timesheet',args||'{"time_code_id":"70000000-0000-4000-8000-000000000003"}');
  assert result->>'total_hours'='1' and result->'entries'->0->'client_id'='null'::jsonb,'Unassigned historical code';
  result:=expense_mcp.read_timesheet('timesheet-access','read_timesheet','{"start_date":"2026-10-02","end_date":"2026-10-02"}');
  assert result->>'total_hours'='5','Single-day range is inclusive';
  result:=expense_mcp.read_timesheet('timesheet-access','read_timesheet','{"start_date":"2026-09-30","end_date":"2026-10-01"}');
  assert result->'entries'->0->>'month_comment'='September note' and result->'entries'->1->>'month_comment'='Monthly note','Cross-month notes';
  result:=expense_mcp.read_timesheet('timesheet-access','read_timesheet','{"start_date":"2026-01-01","end_date":"2026-01-02"}');
  assert result->>'total_hours'='0' and result->>'total_entries'='0' and result->'entries'='[]'::jsonb,'Empty results are explicit';
  begin
    perform expense_mcp.read_timesheet('timesheet-access','read_timesheet',args||'{"client_id":"60000000-0000-4000-8000-000000000003"}');
    raise exception 'Cross workspace client accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform expense_mcp.read_timesheet('timesheet-access','read_timesheet','{"start_date":"2026-01-01","end_date":"2027-01-02"}');
    raise exception 'Oversized range accepted';
  exception when invalid_datetime_format then null; end;
  begin
    perform expense_mcp.read_timesheet('timesheet-access','create_time_entry',args);
    raise exception 'Write tool accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform 1 from public.time_entries;
    raise exception 'Runtime can access time entries directly';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
  begin
    update public.time_codes set kleer_activity=null where id='70000000-0000-4000-8000-000000000001';
    raise exception 'Incomplete mapping accepted';
  exception when check_violation then null; end;
end $$;
-- Content change must invalidate a previously issued page revision.
create temporary table saved_revision as select expense_mcp.read_timesheet('timesheet-access','read_timesheet','{"start_date":"2026-10-01","end_date":"2026-10-03"}')->>'revision' as value;
update public.time_code_month_comments set comment='Changed note' where workspace_id='10000000-0000-4000-8000-000000000001' and month_start='2026-10-01';
do $$ begin
  begin
    perform expense_mcp.read_timesheet('timesheet-access','read_timesheet',jsonb_build_object('start_date','2026-10-01','end_date','2026-10-03','offset',2,'revision',(select value from saved_revision)));
    raise exception 'Stale revision accepted';
  exception when serialization_failure then null; end;
end $$;
update expense_mcp.grants set access_expires_at=now()-interval '1 second' where access_hash='timesheet-access';
set local role expense_mcp_runtime;
do $$ begin
  begin
    perform expense_mcp.read_timesheet('timesheet-access','list_time_codes','{}');
    raise exception 'Expired token accepted';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
update expense_mcp.grants set access_expires_at=now()+interval '1 hour',revoked_at=now() where access_hash='timesheet-access';
set local role expense_mcp_runtime;
do $$ begin
  begin
    perform expense_mcp.read_timesheet('timesheet-access','list_time_codes','{}');
    raise exception 'Revoked token accepted';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
update expense_mcp.grants set revoked_at=null where access_hash='timesheet-access';
delete from public.workspace_members where user_id='timesheet-reader';
set local role expense_mcp_runtime;
do $$ begin
  begin
    perform expense_mcp.read_timesheet('timesheet-access','list_time_codes','{}');
    raise exception 'Removed member accepted';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
