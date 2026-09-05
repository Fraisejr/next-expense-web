begin;

alter table public.transactions
  add column balance_checkpoint_minor bigint,
  add column adjustment_reason text;

alter table public.transactions
  drop constraint if exists transactions_transaction_type_check,
  drop constraint if exists transactions_category_by_type_check,
  drop constraint if exists transactions_payee_by_type_check;

alter table public.transactions
  add constraint transactions_transaction_type_check
    check (transaction_type in ('expense', 'income', 'transfer', 'opening_balance', 'balance_adjustment')),
  add constraint transactions_category_by_type_check
    check (
      (transaction_type in ('transfer', 'opening_balance', 'balance_adjustment') and category_id is null)
      or (transaction_type in ('expense', 'income') and category_id is not null)
    ) not valid,
  add constraint transactions_payee_by_type_check
    check (transaction_type in ('transfer', 'opening_balance', 'balance_adjustment') or payee_id is not null) not valid,
  add constraint transactions_balance_adjustment_check
    check (
      (transaction_type = 'balance_adjustment'
        and balance_checkpoint_minor is not null
        and adjustment_reason in ('market_valuation', 'asset_valuation', 'liability_adjustment', 'reconciliation', 'other'))
      or (transaction_type <> 'balance_adjustment'
        and balance_checkpoint_minor is null
        and adjustment_reason is null)
    );

create unique index transactions_one_balance_adjustment_per_account_date
  on public.transactions(workspace_id, account_id, transaction_date)
  where transaction_type = 'balance_adjustment';

notify pgrst, 'reload schema';

commit;
