begin;

do $$
declare
  workspace_id_value uuid := 'f6dd1805-9c37-5ff2-9856-56a7abd8cff0';
  tesla_account_id uuid := '28abd5f9-6e7b-4110-aa72-946d250efedd';
  updated_count integer;
begin
  if (
    select count(*)
    from public.transactions
    where workspace_id = workspace_id_value
      and account_id = tesla_account_id
      and id in (
        '31065913-e6dd-4998-a4a0-24177533012c',
        'c81f8dcb-5031-4976-b012-61747e5bc69a'
      )
      and transaction_type = 'expense'
      and category_id is null
      and payee_name = 'Depreciation'
  ) <> 2 then
    raise exception 'The two unchanged Tesla depreciation transactions were not found.';
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
      balance_checkpoint_minor = case id
        when '31065913-e6dd-4998-a4a0-24177533012c' then 4227000
        when 'c81f8dcb-5031-4976-b012-61747e5bc69a' then 3000000
      end,
      adjustment_reason = 'market_valuation',
      memo = case id
        when '31065913-e6dd-4998-a4a0-24177533012c' then 'Acquisition value'
        when 'c81f8dcb-5031-4976-b012-61747e5bc69a' then 'Annual March valuation · 20% declining-balance rule'
      end,
      legacy_uncategorized = false,
      legacy_missing_payee = false
  where workspace_id = workspace_id_value
    and account_id = tesla_account_id
    and id in (
      '31065913-e6dd-4998-a4a0-24177533012c',
      'c81f8dcb-5031-4976-b012-61747e5bc69a'
    );

  get diagnostics updated_count = row_count;
  if updated_count <> 2 then
    raise exception 'Expected to replace two Tesla depreciation transactions, updated %.', updated_count;
  end if;
end;
$$;

commit;
