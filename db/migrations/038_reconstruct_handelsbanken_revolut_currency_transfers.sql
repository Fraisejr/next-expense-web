begin;

do $$
declare
  workspace_id_value uuid := 'f6dd1805-9c37-5ff2-9856-56a7abd8cff0';
  handelsbanken_id uuid;
  revolut_sek_id uuid;
  revolut_eur_id uuid;
  october_2022_period_id uuid;
  plan_row record;
  target_transaction public.transactions%rowtype;
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

  select period_id into strict october_2022_period_id
  from public.transactions
  where workspace_id = workspace_id_value
    and id = '94820fa9-7259-4de9-b1be-00bd913a04f9';

  -- This checkpoint previously described the balance on 31 January 2023.
  -- Move it before the reconstructed history and add back the SEK 110,000
  -- transferred out between 3 October and 30 January.
  update public.transactions
  set transaction_date = date '2022-10-02',
      source_timestamp = timestamptz '2022-10-02 12:00:00+00',
      period_id = october_2022_period_id,
      amount_minor = 18371349,
      memo = 'Inferred starting balance before reconstructed Revolut transfers'
  where workspace_id = workspace_id_value
    and id = '9297e908-bb91-44b9-b129-f43eeb90c044';

  if not found then
    raise exception 'The Handelsbanken opening balance was not found.';
  end if;

  for plan_row in
    select *
    from (values
      ('94820fa9-7259-4de9-b1be-00bd913a04f9'::uuid, '77b38de0-f600-4ea6-a7ad-ab714ab063e4'::uuid, 1000000::bigint, 91723::bigint, null::uuid),
      ('af5fd4dc-cf47-44ad-aa74-c0760a05946e'::uuid, 'd02404eb-1e89-44fe-81b4-b447a98660b4'::uuid, 2000000::bigint, 183797::bigint, null::uuid),
      ('4b6a692f-fe92-492a-8e59-3da283a60c9a'::uuid, 'd4436afd-d395-42d8-b5e5-0549d0d70aa6'::uuid, 500000::bigint, 45688::bigint, null::uuid),
      ('697a6892-6a01-4eec-a451-a3d185ef78db'::uuid, '84b59ee3-896e-484e-9132-21ff2dd23573'::uuid, 1000000::bigint, 92167::bigint, null::uuid),
      ('f7226e2f-bacb-43de-9efb-28d06733b673'::uuid, '4f17be66-697e-4c12-aa32-81dc60e58cf3'::uuid, 2000000::bigint, 183122::bigint, null::uuid),
      ('9cb23d4d-ca70-42a2-a9a7-b68914d2bc3d'::uuid, '97adc642-83bd-44e8-a65a-557bd314b5c8'::uuid, 3500000::bigint, 311032::bigint, null::uuid),
      ('cfb094d6-0829-474b-b6a1-cd2bd56ce675'::uuid, 'ca76fc29-a18e-4977-b3a8-d1eed8732707'::uuid, 500000::bigint, 44599::bigint, null::uuid),
      ('be40608e-9e7e-47c8-9b6a-a28bf461432d'::uuid, '3ab6a577-8411-4fc3-aa4d-c99cc7586e26'::uuid, 500000::bigint, 44435::bigint, null::uuid),
      ('811eef30-1bdd-4513-854a-f8d240355cf3'::uuid, null::uuid, 2000000::bigint, 176186::bigint, '01c806b9-e53b-4335-9fe2-762d0f8652d1'::uuid),
      ('3436b1c5-d44c-482e-b64d-2241305eb6bc'::uuid, null::uuid, 1000000::bigint, 88080::bigint, '4415bb40-75e3-49bc-8de8-8eee35f5a57d'::uuid)
    ) as plan(target_id, funding_id, sek_amount_minor, eur_amount_minor, existing_funding_id)
  loop
    select * into strict target_transaction
    from public.transactions
    where workspace_id = workspace_id_value and id = plan_row.target_id;

    if target_transaction.transaction_date not between date '2022-10-03' and date '2023-02-02'
      or (
        target_transaction.transaction_type = 'income'
        and (target_transaction.account_id <> revolut_eur_id
          or target_transaction.currency <> 'EUR'
          or target_transaction.amount_minor <> plan_row.eur_amount_minor)
      )
      or (
        target_transaction.transaction_type = 'transfer'
        and (target_transaction.account_id <> revolut_sek_id
          or target_transaction.destination_account_id <> revolut_eur_id
          or target_transaction.amount_minor <> plan_row.sek_amount_minor
          or target_transaction.destination_amount_minor <> plan_row.eur_amount_minor)
      )
      or target_transaction.transaction_type not in ('income', 'transfer')
    then
      raise exception 'Unexpected source transaction state for %.', plan_row.target_id;
    end if;

    if plan_row.existing_funding_id is null then
      insert into public.transactions (
        id, workspace_id, account_id, destination_account_id, period_id,
        transaction_date, source_timestamp, source_created_at,
        amount_minor, destination_amount_minor, currency, transaction_type,
        memo, posted, reconciled, source
      ) values (
        plan_row.funding_id, workspace_id_value, handelsbanken_id, revolut_sek_id,
        target_transaction.period_id, target_transaction.transaction_date,
        target_transaction.source_timestamp - interval '1 minute',
        target_transaction.source_created_at,
        plan_row.sek_amount_minor, plan_row.sek_amount_minor, 'SEK', 'transfer',
        'Reconstructed from Revolut history · Apple Pay top-up',
        true, true, 'reconstructed_history'
      )
      on conflict (id) do nothing;
    else
      update public.transactions
      set destination_account_id = revolut_sek_id,
          destination_amount_minor = plan_row.sek_amount_minor,
          currency = 'SEK',
          transaction_type = 'transfer',
          category_id = null,
          payee_id = null,
          debtor_id = null,
          payee_name = null,
          memo = 'Apple Pay top-up',
          legacy_uncategorized = false,
          legacy_missing_payee = false
      where workspace_id = workspace_id_value
        and id = plan_row.existing_funding_id
        and account_id = handelsbanken_id
        and amount_minor = plan_row.sek_amount_minor;

      if not found then
        raise exception 'Expected Handelsbanken funding transaction % was not found.', plan_row.existing_funding_id;
      end if;
    end if;

    update public.transactions
    set account_id = revolut_sek_id,
        destination_account_id = revolut_eur_id,
        amount_minor = plan_row.sek_amount_minor,
        destination_amount_minor = plan_row.eur_amount_minor,
        currency = 'SEK',
        transaction_type = 'transfer',
        category_id = null,
        payee_id = null,
        debtor_id = null,
        payee_name = null,
        memo = 'SEK → EUR',
        legacy_uncategorized = false,
        legacy_missing_payee = false
    where workspace_id = workspace_id_value and id = plan_row.target_id;
  end loop;
end;
$$;

commit;
