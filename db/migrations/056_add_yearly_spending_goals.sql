begin;

alter table public.workspaces
  add column yearly_spending_goals jsonb not null default '{}'::jsonb
  check (jsonb_typeof(yearly_spending_goals) = 'object');

notify pgrst, 'reload schema';

commit;
