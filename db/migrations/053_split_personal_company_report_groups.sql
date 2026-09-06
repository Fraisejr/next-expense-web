begin;

alter table public.categories
  drop constraint if exists categories_report_group_check;

update public.categories category
set report_group = case
  when category.report_group = 'income' and lower(category_group.name) = 'company' then 'company_revenue'
  when category.report_group = 'expense' and lower(category_group.name) = 'company' then 'company_expense'
  when category.report_group = 'income' then 'personal_income'
  when category.report_group = 'expense' then 'personal_expense'
  else category.report_group
end
from public.category_groups category_group
where category.category_group_id = category_group.id
  and category.workspace_id = category_group.workspace_id
  and category.report_group in ('income', 'expense');

update public.categories
set report_group = case
  when report_group = 'income' then 'personal_income'
  else 'personal_expense'
end
where report_group in ('income', 'expense');

alter table public.categories
  add constraint categories_report_group_check
  check (report_group in ('personal_income', 'personal_expense', 'company_revenue', 'company_expense', 'tax'));

commit;
