begin;

-- A dedicated server login inherits this role. Do not use an owner connection
-- in the HTTP server. OAuth data stays outside the public Data API schema.
do $$ begin
  if not exists(select 1 from pg_roles where rolname='expense_mcp_runtime') then
    create role expense_mcp_runtime nologin;
  end if;
end $$;
create schema if not exists expense_mcp;
revoke all on schema expense_mcp from public;
create table expense_mcp.records (
  id text primary key,
  kind text not null check(kind in ('client','request','code')),
  value jsonb not null,
  expires_at timestamptz not null
);
create index on expense_mcp.records(expires_at);
create table expense_mcp.grants (
  id uuid primary key,
  user_id text not null,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  client_id text not null,
  client_name text not null,
  resource text not null,
  scope text not null check(scope in ('expenses:read','expenses:read expenses:write','expenses:write expenses:read')),
  access_hash text not null unique,
  refresh_hash text not null unique,
  access_expires_at timestamptz not null,
  refresh_expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index on expense_mcp.grants(user_id,workspace_id);
-- View exposes membership only to the private server role; no financial rows.
create view expense_mcp.active_memberships with (security_barrier=true) as
  select user_id,workspace_id,role from public.workspace_members;
grant usage on schema expense_mcp to expense_mcp_runtime;
grant select,insert,update,delete on expense_mcp.records,expense_mcp.grants to expense_mcp_runtime;
grant select on expense_mcp.active_memberships to expense_mcp_runtime;

create function expense_mcp.execute_tool(p_access_hash text,p_tool text,p_args jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  g expense_mcp.grants%rowtype;
  member_role text;
  w uuid;
  result jsonb;
  target_period uuid;
  target_id uuid;
  tx public.transactions%rowtype;
  target_date date;
  category_type text;
  is_read boolean;
begin
  select * into g from expense_mcp.grants where access_hash=p_access_hash
    and revoked_at is null and access_expires_at>now();
  if g.id is null then raise exception 'Connection expired. Reconnect your account.'; end if;
  w := g.workspace_id;
  select role into member_role from public.workspace_members where workspace_id=w and user_id=g.user_id;
  if member_role is null then raise exception 'Workspace access was removed.'; end if;
  is_read := p_tool in ('get_workspace','list_accounts','list_categories','list_payees','list_transactions','spending_summary','list_budgets');
  if position('expenses:read' in g.scope)=0 then raise exception 'Read permission required.'; end if;
  if not is_read and (position('expenses:write' in g.scope)=0 or member_role not in ('owner','member')) then
    raise exception 'Write permission required.';
  end if;
  if p_args ? 'start_date' and (p_args->>'start_date')::date > (p_args->>'end_date')::date then raise exception 'Invalid date range.'; end if;
  if p_tool='get_workspace' then
    select jsonb_build_object('id',id,'name',name,'default_currency',default_currency,'role',member_role) into result from public.workspaces where id=w;
  elsif p_tool='list_accounts' then
    select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) into result from (
      select id,name,currency,account_type,scope,closed from public.accounts where workspace_id=w order by sort_order,id
    ) t;
  elsif p_tool='list_categories' then
    select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) into result from (
      select id,name,category_type,report_group,hidden from public.categories where workspace_id=w order by sort_order,id
    ) t;
  elsif p_tool='list_payees' then
    select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) into result from (
      select id,name from public.payees where workspace_id=w and (not p_args ? 'search' or name ilike '%'||(p_args->>'search')||'%') order by name,id
      limit least(greatest(coalesce((p_args->>'limit')::integer,50),1),100) offset least(greatest(coalesce((p_args->>'offset')::integer,0),0),100000)
    ) t;
  elsif p_tool='list_transactions' then
    select jsonb_build_object('items',coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb),'limit',least(greatest(coalesce((p_args->>'limit')::integer,50),1),100),'offset',coalesce((p_args->>'offset')::integer,0)) into result from (
      select id,account_id,category_id,payee_id,transaction_date,transaction_type,amount_minor::text as amount_minor,currency,payee_name,memo,bank_memo,posted,source
      from public.transactions where workspace_id=w and transaction_date between (p_args->>'start_date')::date and (p_args->>'end_date')::date
        and (not p_args ? 'account_id' or account_id=(p_args->>'account_id')::uuid)
        and (not p_args ? 'category_id' or category_id=(p_args->>'category_id')::uuid)
        and (not p_args ? 'payee_id' or payee_id=(p_args->>'payee_id')::uuid)
        and (not p_args ? 'search' or coalesce(memo,'')||' '||coalesce(payee_name,'') ilike '%'||(p_args->>'search')||'%')
      order by transaction_date desc,id
      limit least(greatest(coalesce((p_args->>'limit')::integer,50),1),100) offset least(greatest(coalesce((p_args->>'offset')::integer,0),0),100000)
    ) t;
  elsif p_tool='spending_summary' then
    select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) into result from (
      select category_id,currency,transaction_type,count(*) as transaction_count,sum(amount_minor)::text as amount_minor
      from public.transactions where workspace_id=w and posted and transaction_type in ('expense','income')
        and transaction_date between (p_args->>'start_date')::date and (p_args->>'end_date')::date
      group by category_id,currency,transaction_type order by currency,transaction_type,category_id
    ) t;
  elsif p_tool='list_budgets' then
    select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) into result from (
      select b.id,b.category_id,b.amount_minor::text as amount_minor,ws.default_currency as currency from public.budgets b
      join public.periods p on p.id=b.period_id and p.workspace_id=b.workspace_id
      join public.workspaces ws on ws.id=b.workspace_id
      where b.workspace_id=w and p.year=substring(p_args->>'month',1,4)::integer and p.month=substring(p_args->>'month',6,2)::integer order by b.category_id
    ) t;
  elsif p_tool='create_payee' then
    if length(trim(p_args->>'name')) not between 1 and 200 then raise exception 'A payee name is required.'; end if;
    perform pg_advisory_xact_lock(hashtextextended(w::text||lower(trim(p_args->>'name')),0));
    select id into target_id from public.payees where workspace_id=w and lower(name)=lower(trim(p_args->>'name')) order by id limit 1;
    if target_id is null then
      target_id:=gen_random_uuid();
      insert into public.payees(id,workspace_id,name) values(target_id,w,trim(p_args->>'name'));
    end if;
    result:=jsonb_build_object('id',target_id,'name',trim(p_args->>'name'));
  elsif p_tool in ('create_transaction','update_transaction','set_budget') then
    if p_tool='update_transaction' then
      select * into tx from public.transactions where workspace_id=w and id=(p_args->>'transaction_id')::uuid for update;
      if tx.id is null or tx.transaction_type not in ('expense','income') then raise exception 'Read an existing expense or income before editing.'; end if;
      target_date:=coalesce((p_args->>'date')::date,tx.transaction_date);
    elsif p_tool='create_transaction' then
      target_date:=(p_args->>'date')::date;
      if p_args->>'type' not in ('expense','income') or (p_args->>'amount_minor')::bigint not between 1 and 9007199254740991 then raise exception 'Invalid transaction type or amount.'; end if;
      if not exists(select 1 from public.accounts where workspace_id=w and id=(p_args->>'account_id')::uuid and currency=p_args->>'currency' and not closed) then raise exception 'Choose an open account with the same currency.'; end if;
    else
      target_date:=(p_args->>'month'||'-01')::date;
      if (p_args->>'amount_minor')::bigint not between 0 and 9007199254740991 then raise exception 'Invalid budget amount.'; end if;
    end if;
    if p_tool!='set_budget' then
      select c.category_type into category_type from public.categories c where c.workspace_id=w
        and c.id=coalesce((p_args->>'category_id')::uuid,tx.category_id) and not c.hidden;
      if category_type is null or (coalesce(p_args->>'type',tx.transaction_type)='income' and category_type!='Income') or
         (coalesce(p_args->>'type',tx.transaction_type)='expense' and category_type not in ('Expense','Investment')) then raise exception 'Choose an active category matching the transaction type.'; end if;
      if not exists(select 1 from public.payees where workspace_id=w and id=coalesce((p_args->>'payee_id')::uuid,tx.payee_id) and not transfer_payee) then raise exception 'Choose a payee in this workspace.'; end if;
    elsif not exists(select 1 from public.categories where workspace_id=w and id=(p_args->>'category_id')::uuid and not hidden) then raise exception 'Choose an active category in this workspace.'; end if;
    if target_date not between date '1900-01-01' and date '2200-12-31' then raise exception 'Invalid date.'; end if;
    insert into public.periods(id,workspace_id,year,month,month_label,period_start_date)
      values(gen_random_uuid(),w,extract(year from target_date)::integer,extract(month from target_date)::integer,to_char(target_date,'YYYY-MM'),date_trunc('month',target_date)::date)
      on conflict(workspace_id,year,month) do update set year=excluded.year returning id into target_period;
    if p_tool='create_transaction' then
      target_id:=(p_args->>'transaction_id')::uuid;
      insert into public.transactions(id,workspace_id,account_id,period_id,category_id,payee_id,transaction_date,source_timestamp,source_created_at,amount_minor,currency,transaction_type,payee_name,memo,posted,reconciled,source)
        values(target_id,w,(p_args->>'account_id')::uuid,target_period,(p_args->>'category_id')::uuid,(p_args->>'payee_id')::uuid,target_date,target_date+time '12:00',now(),(p_args->>'amount_minor')::bigint,p_args->>'currency',p_args->>'type',(select name from public.payees where workspace_id=w and id=(p_args->>'payee_id')::uuid),nullif(trim(p_args->>'memo'),''),true,true,'manual')
        on conflict(id) do nothing;
      select * into tx from public.transactions where workspace_id=w and id=target_id;
      if tx.id is null or tx.source!='manual' or tx.account_id!=(p_args->>'account_id')::uuid or tx.category_id!=(p_args->>'category_id')::uuid or tx.payee_id!=(p_args->>'payee_id')::uuid or tx.transaction_date!=target_date or tx.amount_minor!=(p_args->>'amount_minor')::bigint or tx.currency!=p_args->>'currency' or tx.transaction_type!=p_args->>'type' or coalesce(tx.memo,'')!=coalesce(trim(p_args->>'memo'),'') then raise exception 'Transaction ID already exists with different details. Read it before retrying.'; end if;
      result:=jsonb_build_object('id',target_id);
    elsif p_tool='update_transaction' then
      update public.transactions set transaction_date=target_date,period_id=target_period,
        category_id=coalesce((p_args->>'category_id')::uuid,category_id),payee_id=coalesce((p_args->>'payee_id')::uuid,payee_id),
        memo=case when p_args ? 'memo' then nullif(trim(p_args->>'memo'),'') else memo end
        where workspace_id=w and id=tx.id;
      result:=jsonb_build_object('id',tx.id);
    else
      insert into public.budgets(id,workspace_id,period_id,category_id,amount_minor)
        values(gen_random_uuid(),w,target_period,(p_args->>'category_id')::uuid,(p_args->>'amount_minor')::bigint)
        on conflict(workspace_id,period_id,category_id) do update set amount_minor=excluded.amount_minor returning id into target_id;
      result:=jsonb_build_object('id',target_id);
    end if;
  else raise exception 'Unknown tool.';
  end if;
  return result;
end $$;
revoke all on function expense_mcp.execute_tool(text,text,jsonb) from public;
grant execute on function expense_mcp.execute_tool(text,text,jsonb) to expense_mcp_runtime;
commit;
