begin;

create temporary table salary_transfer_pairs (
  funding_id uuid primary key,
  exchange_id uuid unique not null,
  sek_amount_minor bigint not null,
  eur_amount_minor bigint not null
) on commit drop;

insert into salary_transfer_pairs (funding_id, exchange_id, sek_amount_minor, eur_amount_minor) values
  ('59e392b3-84c2-445c-8b40-616cf095866a', '03ebd3d4-854c-4c0f-8ea0-407bb363d504', 2000000, 180160),
  ('daaf9f26-e96f-4c7a-8c87-4f46b058c0c4', 'e4a28368-4209-423a-8ccd-05c2a04911e9', 1500000, 134235),
  ('1ec7b3a9-6007-47f6-88d7-1bf551fecdd9', 'fe6f19e5-9736-42e3-b9a1-a2aa2e01f2b2', 2000000, 178252),
  ('2bcd0a7f-fd4c-4d6a-a2a9-4c8bffe05a5a', '123af717-c18a-4338-bf6c-9012098f44e1', 2000000, 178420),
  ('5b76b66f-3fdd-4644-827c-19716f0c5aca', '7fc3e3e2-1e39-4827-8565-bb896060e494', 1000000, 87460),
  ('10b19d08-d734-453a-b79d-0669b71458a1', 'e8a3b4a9-df76-4499-bda3-1f8f5d6822ea', 2000000, 176480),
  ('78504a8d-2798-4ab3-88c1-684e9ae3aeac', '2e502a6f-c683-474d-89bf-b7f67dc2bc9a', 2000000, 178202),
  ('ed6d4215-47e9-42aa-839f-6ce35641b258', 'b678f3be-62e4-41e4-87cd-b0633386f849', 2000000, 178760);

do $$
declare
  workspace_id_value uuid := 'f6dd1805-9c37-5ff2-9856-56a7abd8cff0';
  salary_category_id uuid := 'b477d25f-d780-4a36-8126-844918e1d79e';
  handelsbanken_id uuid;
  revolut_sek_id uuid;
  revolut_eur_id uuid;
  updated_count integer;
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

  if (
    select count(*)
    from salary_transfer_pairs pair
    join public.transactions funding on funding.id = pair.funding_id
    where funding.workspace_id = workspace_id_value
      and funding.account_id = handelsbanken_id
      and funding.transaction_type = 'expense'
      and funding.amount_minor = pair.sek_amount_minor
      and funding.currency = 'SEK'
      and funding.category_id = salary_category_id
  ) <> 8 then
    raise exception 'The eight unchanged Handelsbanken Salary entries were not found.';
  end if;

  if (
    select count(*)
    from salary_transfer_pairs pair
    join public.transactions exchange on exchange.id = pair.exchange_id
    where exchange.workspace_id = workspace_id_value
      and exchange.account_id = revolut_eur_id
      and exchange.transaction_type = 'income'
      and exchange.amount_minor = pair.eur_amount_minor
      and exchange.currency = 'EUR'
      and exchange.category_id = salary_category_id
  ) <> 8 then
    raise exception 'The eight unchanged Revolut EUR Salary entries were not found.';
  end if;

  update public.transactions funding
  set destination_account_id = revolut_sek_id,
      destination_amount_minor = pair.sek_amount_minor,
      transaction_type = 'transfer',
      category_id = null,
      payee_id = null,
      debtor_id = null,
      payee_name = null,
      memo = 'Apple Pay top-up',
      legacy_uncategorized = false,
      legacy_missing_payee = false,
      updated_at = now()
  from salary_transfer_pairs pair
  where funding.workspace_id = workspace_id_value
    and funding.id = pair.funding_id;

  get diagnostics updated_count = row_count;
  if updated_count <> 8 then
    raise exception 'Expected to convert eight Handelsbanken funding entries, converted %.', updated_count;
  end if;

  update public.transactions exchange
  set account_id = revolut_sek_id,
      destination_account_id = revolut_eur_id,
      amount_minor = pair.sek_amount_minor,
      destination_amount_minor = pair.eur_amount_minor,
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
  from salary_transfer_pairs pair
  where exchange.workspace_id = workspace_id_value
    and exchange.id = pair.exchange_id;

  get diagnostics updated_count = row_count;
  if updated_count <> 8 then
    raise exception 'Expected to convert eight currency exchanges, converted %.', updated_count;
  end if;

  if exists (
    select 1
    from public.transactions
    where workspace_id = workspace_id_value and category_id = salary_category_id
  ) then
    raise exception 'Transactions remain in the Salary category.';
  end if;

  if (
    select count(*)
    from salary_transfer_pairs pair
    join public.transactions funding on funding.id = pair.funding_id
    join public.transactions exchange on exchange.id = pair.exchange_id
    where funding.account_id = handelsbanken_id
      and funding.destination_account_id = revolut_sek_id
      and funding.amount_minor = pair.sek_amount_minor
      and funding.destination_amount_minor = pair.sek_amount_minor
      and funding.transaction_type = 'transfer'
      and exchange.account_id = revolut_sek_id
      and exchange.destination_account_id = revolut_eur_id
      and exchange.amount_minor = pair.sek_amount_minor
      and exchange.destination_amount_minor = pair.eur_amount_minor
      and exchange.transaction_type = 'transfer'
  ) <> 8 then
    raise exception 'The eight currency-transfer pairs were not reconstructed correctly.';
  end if;
end;
$$;

commit;
