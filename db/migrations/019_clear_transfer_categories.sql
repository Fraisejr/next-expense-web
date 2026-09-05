begin;

-- Transfers move value between owned accounts and do not participate in the
-- combined P&L. Remove category assignments retained from the old app.
update public.transactions
set category_id = null
where transaction_type = 'transfer'
  and category_id is not null;

-- Keep this rule independently valid even while older uncategorized
-- non-transfer transactions are still being reviewed incrementally.
alter table public.transactions
  add constraint transactions_transfer_category_null_check
  check (transaction_type <> 'transfer' or category_id is null);

commit;
