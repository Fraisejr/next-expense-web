begin;

with category_activity as (
  select
    category.id,
    category.name,
    count(t.id) filter (where t.transaction_type = 'income') as income_count,
    count(t.id) filter (where t.transaction_type = 'expense') as expense_count
  from public.categories category
  left join public.transactions t on t.category_id = category.id
  where category.report_group = 'capital_gain'
  group by category.id, category.name
), reclassified as (
  update public.categories category
  set
    report_group = case
      when activity.name ~* '(tax|irpf|cuota ss)' then 'tax'
      when activity.income_count > 0 and activity.expense_count = 0 then 'income'
      else 'expense'
    end,
    category_type = case
      when activity.name !~* '(tax|irpf|cuota ss)'
        and activity.income_count > 0
        and activity.expense_count = 0 then 'Income'
      else 'Expense'
    end,
    hidden = case
      when activity.name ~* '^exchange gains and losses$' then true
      else category.hidden
    end
  from category_activity activity
  where category.id = activity.id
  returning category.id
)
select count(*) from reclassified;

alter table public.categories
  drop constraint if exists categories_report_group_check;

alter table public.categories
  add constraint categories_report_group_check
  check (report_group in ('income', 'expense', 'tax'));

commit;
