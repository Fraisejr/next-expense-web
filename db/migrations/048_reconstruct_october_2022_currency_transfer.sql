begin;

do $$
declare
  workspace_id_value uuid := 'f6dd1805-9c37-5ff2-9856-56a7abd8cff0';
  handelsbanken_id uuid;
  revolut_sek_id uuid;
  revolut_eur_id uuid;
  exchange_id uuid := 'cd18460e-bd40-43c6-8b87-9b3dd648fcfc';
  funding_id uuid := '2cb83569-8306-467c-8064-3b9f48628586';
  handelsbanken_opening_id uuid := '9297e908-bb91-44b9-b129-f43eeb90c044';
  exchange_row public.transactions%rowtype;
begin
  select id into strict handelsbanken_id
  from public.accounts
  where workspace_id = workspace_id_value and name = 'Handelsbanken';

  select id into strict revolut_sek_id
  from public.accounts
  where workspace_id = workspace_id_value and name = 'Revolut SEK';

  select id into strict revolut_eur_id
  from public.accounts
  where workspace_id = workspace_id_value and name = 'Revolut EUR';

  select * into strict exchange_row
  from public.transactions
  where workspace_id = workspace_id_value and id = exchange_id;

  if exchange_row.account_id <> revolut_eur_id
    or exchange_row.transaction_date <> date '2022-10-17'
    or exchange_row.transaction_type <> 'income'
    or exchange_row.amount_minor <> 181773
    or exchange_row.currency <> 'EUR'
  then
    raise exception 'The unchanged €1,817.73 Revolut EUR exchange was not found.';
  end if;

  update public.transactions
  set amount_minor = 20371349,
      memo = 'Inferred starting balance before reconstructed Revolut transfers',
      updated_at = now()
  where workspace_id = workspace_id_value
    and id = handelsbanken_opening_id
    and account_id = handelsbanken_id
    and transaction_type = 'opening_balance'
    and amount_minor = 18371349;

  if not found then
    raise exception 'The expected Handelsbanken inferred opening balance was not found.';
  end if;

  insert into public.transactions (
    id, workspace_id, account_id, destination_account_id, period_id,
    transaction_date, source_timestamp, source_created_at,
    amount_minor, destination_amount_minor, currency, transaction_type,
    memo, posted, reconciled, source
  ) values (
    funding_id, workspace_id_value, handelsbanken_id, revolut_sek_id,
    exchange_row.period_id, exchange_row.transaction_date,
    exchange_row.source_timestamp - interval '1 minute',
    exchange_row.source_created_at,
    2000000, 2000000, 'SEK', 'transfer',
    'Reconstructed from Revolut history · Apple Pay top-up',
    true, true, 'reconstructed_history'
  );

  update public.transactions
  set account_id = revolut_sek_id,
      destination_account_id = revolut_eur_id,
      amount_minor = 2000000,
      destination_amount_minor = 181773,
      currency = 'SEK',
      transaction_type = 'transfer',
      category_id = null,
      payee_id = null,
      debtor_id = null,
      payee_name = null,
      memo = 'SEK → EUR',
      legacy_uncategorized = false,
      legacy_missing_payee = false,
      updated_at = now()
  where workspace_id = workspace_id_value and id = exchange_id;

  if not exists (
    select 1
    from public.transactions
    where workspace_id = workspace_id_value
      and id = funding_id
      and account_id = handelsbanken_id
      and destination_account_id = revolut_sek_id
      and amount_minor = 2000000
      and destination_amount_minor = 2000000
      and transaction_type = 'transfer'
  ) or not exists (
    select 1
    from public.transactions
    where workspace_id = workspace_id_value
      and id = exchange_id
      and account_id = revolut_sek_id
      and destination_account_id = revolut_eur_id
      and amount_minor = 2000000
      and destination_amount_minor = 181773
      and transaction_type = 'transfer'
  ) then
    raise exception 'The October 2022 currency-transfer sequence was not reconstructed correctly.';
  end if;
end;
$$;

commit;
