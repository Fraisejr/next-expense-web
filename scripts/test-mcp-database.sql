-- Run only on a disposable database containing schema migrations 001-020,
-- 068 and 074. Rolls back all fixtures. Never run on the finance database.
begin;
insert into public.workspaces(id,name) values('10000000-0000-4000-8000-000000000001','MCP fixture'),('10000000-0000-4000-8000-000000000002','Other workspace');
insert into public.workspace_members(workspace_id,user_id,role) values('10000000-0000-4000-8000-000000000001','mcp-test-user','owner');
insert into public.accounts(id,workspace_id,name,account_type,currency) values('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Main','Budget','EUR'),('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','Private','Budget','EUR');
insert into public.categories(id,workspace_id,name,category_type) values('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Food','Expense');
insert into public.payees(id,workspace_id,name) values('40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Cafe');
insert into expense_mcp.grants(id,user_id,workspace_id,client_id,client_name,resource,scope,access_hash,refresh_hash,access_expires_at,refresh_expires_at)
values(gen_random_uuid(),'mcp-test-user','10000000-0000-4000-8000-000000000001','client','Test','https://example.com/api/mcp','expenses:read expenses:write','test-access','test-refresh',now()+interval '1 hour',now()+interval '1 day');
set local role expense_mcp_runtime;
do $$
declare
  args jsonb := '{"transaction_id":"50000000-0000-4000-8000-000000000001","account_id":"20000000-0000-4000-8000-000000000001","category_id":"30000000-0000-4000-8000-000000000001","payee_id":"40000000-0000-4000-8000-000000000001","date":"2020-01-02","amount_minor":1234,"currency":"EUR","type":"expense","memo":"Coffee"}';
  result jsonb;
begin
  result:=expense_mcp.execute_tool('test-access','list_accounts','{}');
  if jsonb_array_length(result)!=1 or result->0->>'name'!='Main' then raise exception 'Workspace isolation failed'; end if;
  perform expense_mcp.execute_tool('test-access','create_transaction',args);
  perform expense_mcp.execute_tool('test-access','create_transaction',args);
  result:=expense_mcp.execute_tool('test-access','list_transactions','{"start_date":"2020-01-01","end_date":"2020-01-31"}');
  if jsonb_array_length(result->'items')!=1 then raise exception 'Retry duplicated a transaction'; end if;
  begin
    perform expense_mcp.execute_tool('test-access','create_transaction',args||'{"amount_minor":99}');
    raise exception 'Conflicting retry accepted';
  exception when others then if sqlerrm='Conflicting retry accepted' then raise; end if; end;
  begin
    perform expense_mcp.execute_tool('test-access','create_transaction',args||'{"transaction_id":"50000000-0000-4000-8000-000000000002","account_id":"20000000-0000-4000-8000-000000000002"}');
    raise exception 'Cross-workspace write accepted';
  exception when others then if sqlerrm='Cross-workspace write accepted' then raise; end if; end;
  perform expense_mcp.execute_tool('test-access','update_transaction','{"transaction_id":"50000000-0000-4000-8000-000000000001","memo":"Updated"}');
  result:=expense_mcp.execute_tool('test-access','spending_summary','{"start_date":"2020-01-01","end_date":"2020-01-31"}');
  if result->0->>'amount_minor'!='1234' then raise exception 'Spending total failed'; end if;
  perform expense_mcp.execute_tool('test-access','set_budget','{"month":"2020-01","category_id":"30000000-0000-4000-8000-000000000001","amount_minor":5000}');
  perform expense_mcp.execute_tool('test-access','set_budget','{"month":"2020-01","category_id":"30000000-0000-4000-8000-000000000001","amount_minor":6000}');
  result:=expense_mcp.execute_tool('test-access','list_budgets','{"month":"2020-01"}');
  if jsonb_array_length(result)!=1 or result->0->>'amount_minor'!='6000' then raise exception 'Budget upsert failed'; end if;
  perform expense_mcp.execute_tool('test-access','create_payee','{"name":"Cafe"}');
  result:=expense_mcp.execute_tool('test-access','list_payees','{}');
  if jsonb_array_length(result)!=1 then raise exception 'Duplicate payee created'; end if;
  begin
    perform 1 from public.transactions;
    raise exception 'Runtime has direct financial access';
  exception when insufficient_privilege then null; end;
  update expense_mcp.grants set scope='expenses:read' where access_hash='test-access';
  begin
    perform expense_mcp.execute_tool('test-access','create_payee','{"name":"Blocked"}');
    raise exception 'Read-only token wrote data';
  exception when others then if sqlerrm='Read-only token wrote data' then raise; end if; end;
  update expense_mcp.grants set revoked_at=now() where access_hash='test-access';
  begin
    perform expense_mcp.execute_tool('test-access','list_accounts','{}');
    raise exception 'Revoked token accepted';
  exception when others then if sqlerrm='Revoked token accepted' then raise; end if; end;
end $$;
reset role;
-- A membership removed after consent blocks the stored token immediately.
update expense_mcp.grants set revoked_at=null where access_hash='test-access';
delete from public.workspace_members where user_id='mcp-test-user';
set local role expense_mcp_runtime;
do $$ begin
  begin
    perform expense_mcp.execute_tool('test-access','list_accounts','{}');
    raise exception 'Removed member retained access';
  exception when others then if sqlerrm='Removed member retained access' then raise; end if; end;
end $$;
rollback;
