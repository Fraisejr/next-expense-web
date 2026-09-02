begin;

alter table public.accounts
  add column display_type text not null default 'Checking'
    check (display_type in ('Checking', 'Savings', 'Cash')),
  add column color text not null default '#234e46',
  add column opening_balance_minor bigint not null default 0;

update public.accounts
set display_type = case
  when investment or pension then 'Savings'
  when account_type = 'External' then 'Savings'
  else 'Checking'
end,
color = case
  when investment or pension then '#d68853'
  when account_type = 'External' then '#777a6d'
  else '#234e46'
end;

alter table public.categories
  add column report_group text not null default 'expense'
    check (report_group in ('income', 'expense', 'tax', 'capital_gain'));

update public.categories
set report_group = case
  when category_type = 'Income' then 'income'
  when category_type = 'Investment' then 'capital_gain'
  when name ~* '(tax|irpf|cuota ss)' then 'tax'
  else 'expense'
end;

alter table public.budgets
  add column scope text not null default 'Personal'
    check (scope in ('Personal', 'Company'));

create or replace function public.is_workspace_member(target_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members member
    where member.workspace_id = target_workspace_id
      and member.user_id = auth.user_id()::text
  );
$$;

revoke all on function public.is_workspace_member(uuid) from public;
grant execute on function public.is_workspace_member(uuid) to authenticated;

create policy workspace_members_read_self on public.workspace_members
  for select to authenticated
  using (user_id = auth.user_id()::text);

create policy workspaces_member_access on public.workspaces
  for all to authenticated
  using (public.is_workspace_member(id))
  with check (public.is_workspace_member(id));

create policy accounts_member_access on public.accounts
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
create policy category_groups_member_access on public.category_groups
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
create policy categories_member_access on public.categories
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
create policy payees_member_access on public.payees
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
create policy payee_mappings_member_access on public.payee_mappings
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
create policy periods_member_access on public.periods
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
create policy budgets_member_access on public.budgets
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
create policy fx_rates_member_access on public.fx_rates
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
create policy transactions_member_access on public.transactions
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
create policy bank_connections_member_access on public.bank_connections
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
create policy import_runs_member_read on public.import_runs
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

commit;
