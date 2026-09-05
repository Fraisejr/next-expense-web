begin;

-- Budget scope belonged to the old split Personal/Company reporting model.
-- The combined P&L has one plan amount for each category and month.
with ranked_budgets as (
  select id,
    row_number() over (
      partition by workspace_id, period_id, category_id
      order by updated_at desc, id desc
    ) as duplicate_rank
  from public.budgets
)
delete from public.budgets
where id in (
  select id
  from ranked_budgets
  where duplicate_rank > 1
);

update public.budgets
set scope = 'Personal'
where scope <> 'Personal';

alter table public.budgets
  add constraint budgets_workspace_period_category_key
  unique (workspace_id, period_id, category_id);

commit;
