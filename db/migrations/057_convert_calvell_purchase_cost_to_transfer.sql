begin;

do $$
declare
  workspace_id_value constant uuid := 'f6dd1805-9c37-5ff2-9856-56a7abd8cff0';
  transaction_id_value constant uuid := '0cb087ca-67cb-4b40-a937-1d6fc2d562ba';
  valuation_id_value constant uuid := 'b17a668d-0a8b-40db-9f5a-e11f35198eb2';
  caixabank_id constant uuid := '5655ace4-d206-4cdf-b828-38842f4e4092';
  calvell_id constant uuid := 'c9ce39e7-37f5-49b3-aa3d-f788941d2ae2';
  updated_count integer;
begin
  if not exists (
    select 1
    from public.transactions
    where workspace_id = workspace_id_value
      and id = transaction_id_value
      and account_id = caixabank_id
      and transaction_date = date '2024-07-19'
      and transaction_type = 'expense'
      and amount_minor = 3980799
      and currency = 'EUR'
      and memo = 'Provision gastos compra'
      and destination_account_id is null
  ) then
    raise exception 'The unchanged CaixaBank purchase-cost transaction was not found.';
  end if;

  if not exists (
    select 1
    from public.transactions
    where workspace_id = workspace_id_value
      and id = valuation_id_value
      and account_id = calvell_id
      and transaction_date = date '2025-04-03'
      and transaction_type = 'balance_adjustment'
      and adjustment_reason = 'asset_valuation'
      and balance_checkpoint_minor = 42000000
  ) then
    raise exception 'The unchanged Apartment Calvell valuation was not found.';
  end if;

  update public.transactions
  set transaction_type = 'transfer',
      destination_account_id = calvell_id,
      destination_amount_minor = 3980799,
      category_id = null,
      payee_id = null,
      debtor_id = null,
      payee_name = null,
      legacy_uncategorized = false,
      legacy_missing_payee = false,
      updated_at = now()
  where workspace_id = workspace_id_value
    and id = transaction_id_value;

  get diagnostics updated_count = row_count;
  if updated_count <> 1 then
    raise exception 'Expected to convert one CaixaBank expense, converted %.', updated_count;
  end if;

  -- The checkpoint is an absolute property value. Keeping it at €420,000
  -- makes the effective revaluation absorb the additional acquisition cost.
  update public.transactions
  set balance_checkpoint_minor = 42000000,
      updated_at = now()
  where workspace_id = workspace_id_value
    and id = valuation_id_value;

  get diagnostics updated_count = row_count;
  if updated_count <> 1 then
    raise exception 'Expected to preserve one Apartment Calvell valuation, updated %.', updated_count;
  end if;

  if not exists (
    select 1
    from public.transactions
    where workspace_id = workspace_id_value
      and id = transaction_id_value
      and account_id = caixabank_id
      and destination_account_id = calvell_id
      and transaction_type = 'transfer'
      and amount_minor = 3980799
      and destination_amount_minor = 3980799
      and category_id is null
      and payee_id is null
  ) then
    raise exception 'The CaixaBank purchase-cost transfer was not reconstructed correctly.';
  end if;

  if not exists (
    select 1
    from public.workspace_account_balances(workspace_id_value)
    where account_id = calvell_id
      and balance_minor = 42000000
  ) then
    raise exception 'Apartment Calvell is no longer valued at EUR 420,000.';
  end if;
end;
$$;

commit;
