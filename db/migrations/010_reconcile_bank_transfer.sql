begin;

create or replace function public.reconcile_bank_transfer(
  p_workspace_id uuid,
  p_expense_id uuid,
  p_income_id uuid,
  p_provider text default 'gocardless_bank_account_data'
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  expense_row public.transactions%rowtype;
  income_row public.transactions%rowtype;
begin
  select * into expense_row
  from public.transactions
  where workspace_id = p_workspace_id and id = p_expense_id
  for update;

  select * into income_row
  from public.transactions
  where workspace_id = p_workspace_id and id = p_income_id
  for update;

  if expense_row.id is null or income_row.id is null then
    raise exception 'Both bank transaction legs are required.';
  end if;
  if expense_row.transaction_type <> 'expense' or income_row.transaction_type <> 'income' then
    raise exception 'Bank transfer legs must have opposite directions.';
  end if;
  if expense_row.account_id = income_row.account_id
    or expense_row.currency <> income_row.currency
    or expense_row.amount_minor <> income_row.amount_minor
    or abs(expense_row.transaction_date - income_row.transaction_date) > 3 then
    raise exception 'Bank transaction legs do not form an unambiguous transfer.';
  end if;

  update public.transactions
  set transaction_type = 'transfer',
      destination_account_id = income_row.account_id,
      destination_amount_minor = income_row.amount_minor,
      category_id = null,
      payee_id = null,
      reconciled = expense_row.reconciled and income_row.reconciled,
      memo = coalesce(nullif(expense_row.memo, ''), nullif(income_row.memo, ''))
  where workspace_id = p_workspace_id and id = expense_row.id;

  insert into public.bank_transaction_refs (
    workspace_id, transaction_id, account_id, provider,
    provider_transaction_id, bank_transaction_id
  ) values
    (
      p_workspace_id, expense_row.id, expense_row.account_id, p_provider,
      expense_row.provider_transaction_id, expense_row.bank_transaction_id
    ),
    (
      p_workspace_id, expense_row.id, income_row.account_id, p_provider,
      income_row.provider_transaction_id, income_row.bank_transaction_id
    )
  on conflict do nothing;

  delete from public.transactions
  where workspace_id = p_workspace_id and id = income_row.id;

  return expense_row.id;
end;
$$;

revoke all on function public.reconcile_bank_transfer(uuid, uuid, uuid, text) from public;
grant execute on function public.reconcile_bank_transfer(uuid, uuid, uuid, text) to authenticated;

commit;
