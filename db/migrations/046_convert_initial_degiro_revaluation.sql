begin;

do $$
declare
  workspace_id_value uuid := 'f6dd1805-9c37-5ff2-9856-56a7abd8cff0';
  degiro_account_id uuid;
  transaction_id_value uuid := 'bb3d3d80-430e-4483-be14-16b240bb2df2';
begin
  select id into strict degiro_account_id
  from public.accounts
  where workspace_id = workspace_id_value and name = 'Degiro';

  if not exists (
    select 1
    from public.transactions
    where workspace_id = workspace_id_value
      and id = transaction_id_value
      and account_id = degiro_account_id
      and transaction_date = date '2022-10-31'
      and transaction_type = 'income'
      and amount_minor = 286922
  ) then
    raise exception 'The unchanged DEGIRO €2,869.22 revaluation was not found.';
  end if;

  if exists (
    select 1
    from public.transactions
    where workspace_id = workspace_id_value
      and account_id = degiro_account_id
      and transaction_date = date '2022-10-31'
      and transaction_type = 'balance_adjustment'
  ) then
    raise exception 'DEGIRO already has a balance adjustment on 31 October 2022.';
  end if;

  if (
    select coalesce(sum(
      case transaction_type
        when 'income' then amount_minor
        when 'expense' then -amount_minor
        when 'opening_balance' then amount_minor
        when 'transfer' then -amount_minor
        else 0
      end
    ), 0)
    from public.transactions
    where workspace_id = workspace_id_value
      and account_id = degiro_account_id
      and transaction_date <= date '2022-10-31'
  ) <> 4388400 then
    raise exception 'The expected DEGIRO closing balance of €43,884.00 was not reproduced.';
  end if;

  update public.transactions
  set transaction_type = 'balance_adjustment',
      amount_minor = 0,
      destination_amount_minor = 0,
      destination_account_id = null,
      category_id = null,
      payee_id = null,
      debtor_id = null,
      payee_name = null,
      balance_checkpoint_minor = 4388400,
      adjustment_reason = 'market_valuation',
      memo = 'Market valuation',
      legacy_uncategorized = false,
      legacy_missing_payee = false,
      source_timestamp = '2022-10-31 23:59:59+00'::timestamptz,
      updated_at = now()
  where workspace_id = workspace_id_value and id = transaction_id_value;

  if not exists (
    select 1
    from public.transactions
    where workspace_id = workspace_id_value
      and id = transaction_id_value
      and transaction_type = 'balance_adjustment'
      and balance_checkpoint_minor = 4388400
      and adjustment_reason = 'market_valuation'
      and category_id is null
      and payee_id is null
  ) then
    raise exception 'The DEGIRO market valuation was not converted correctly.';
  end if;
end;
$$;

commit;
