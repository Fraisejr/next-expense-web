begin;

update public.categories
set report_group = 'company_tax'
where lower(name) = 'taxes & social charges'
  and report_group = 'company_expense';

commit;
