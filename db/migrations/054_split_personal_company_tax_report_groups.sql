begin;

alter table public.categories
  drop constraint if exists categories_report_group_check;

update public.categories category
set report_group = case
  when lower(category_group.name) = 'company' then 'company_tax'
  else 'personal_tax'
end
from public.category_groups category_group
where category.category_group_id = category_group.id
  and category.workspace_id = category_group.workspace_id
  and category.report_group = 'tax';

update public.categories
set report_group = 'personal_tax'
where report_group = 'tax';

alter table public.categories
  add constraint categories_report_group_check
  check (report_group in ('personal_income', 'personal_expense', 'personal_tax', 'company_revenue', 'company_expense', 'company_tax'));

commit;
