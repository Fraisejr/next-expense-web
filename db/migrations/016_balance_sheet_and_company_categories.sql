begin;

alter table public.accounts
  add column balance_sheet_group text not null default 'Personal'
    check (balance_sheet_group in ('Personal', 'Company', 'Real estate', 'Pension'));

update public.accounts
set balance_sheet_group = case
  when pension then 'Pension'
  when lower(name) like '%apartment%'
    or lower(name) in ('mortgage', 'bolån') then 'Real estate'
  when scope = 'Company' then 'Company'
  else 'Personal'
end;

insert into public.category_groups (id, workspace_id, name, sort_order, show_categories)
select gen_random_uuid(), workspace.id, 'Company',
  coalesce((select max(existing.sort_order) + 10 from public.category_groups existing where existing.workspace_id = workspace.id), 0),
  true
from public.workspaces workspace
where not exists (
  select 1 from public.category_groups existing
  where existing.workspace_id = workspace.id and lower(existing.name) = 'company'
);

insert into public.categories (
  id, workspace_id, category_group_id, name, category_type,
  color, icon, sort_order, hidden, default_budget_minor, report_group
)
select gen_random_uuid(), workspace.id, company_group.id, proposed.name, proposed.category_type,
  proposed.color, proposed.icon, proposed.sort_order, false, 0, proposed.report_group
from public.workspaces workspace
join public.category_groups company_group
  on company_group.workspace_id = workspace.id and lower(company_group.name) = 'company'
cross join (values
  ('Client income', 'Income', '#2f6f62', 'briefcase', 0, 'income'),
  ('Company expenses', 'Expense', '#5d7d91', 'receipt', 10, 'expense'),
  ('Taxes & social charges', 'Expense', '#9b6a71', 'receipt', 20, 'expense')
) as proposed(name, category_type, color, icon, sort_order, report_group)
where not exists (
  select 1 from public.categories existing
  where existing.workspace_id = workspace.id and lower(existing.name) = lower(proposed.name)
);

commit;

-- Neon Data API/PostgREST may otherwise continue serving its pre-migration schema.
notify pgrst, 'reload schema';
