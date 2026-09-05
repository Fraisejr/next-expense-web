begin;

-- Opening balances need a date and an audit trail, so they live in the
-- transaction register without participating in budgets or the P&L.
alter table public.transactions
  drop constraint if exists transactions_transaction_type_check,
  drop constraint if exists transactions_category_by_type_check,
  drop constraint if exists transactions_payee_by_type_check,
  drop constraint if exists transactions_transfer_category_null_check;

alter table public.transactions
  add constraint transactions_transaction_type_check
    check (transaction_type in ('expense', 'income', 'transfer', 'opening_balance')),
  add constraint transactions_category_by_type_check
    check (
      (transaction_type in ('transfer', 'opening_balance') and category_id is null)
      or (transaction_type in ('expense', 'income') and category_id is not null)
    ) not valid,
  add constraint transactions_payee_by_type_check
    check (transaction_type in ('transfer', 'opening_balance') or payee_id is not null)
    not valid;

-- This is the first Revolut EUR entry and has no payee, memo, or matching
-- transfer. Preserve its balance effect while removing it from October income.
update public.transactions
set transaction_type = 'opening_balance',
    category_id = null,
    payee_id = null,
    payee_name = null,
    memo = null,
    destination_account_id = null,
    destination_amount_minor = 0,
    updated_at = now()
where id = '3869a028-f1e0-4150-af08-65ff35a253ec'
  and account_id = '269d68be-cc85-46bb-a563-b2d7079c4371'
  and transaction_date = date '2022-10-01'
  and transaction_type = 'income'
  and amount_minor = 105626;

do $$
begin
  if exists (select 1 from public.accounts where opening_balance_minor <> 0) then
    raise exception 'Cannot retire accounts.opening_balance_minor while non-zero values exist';
  end if;
end $$;

alter table public.accounts drop column opening_balance_minor;

commit;
