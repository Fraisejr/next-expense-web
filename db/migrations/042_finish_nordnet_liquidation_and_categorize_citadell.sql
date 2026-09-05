begin;

do $$
declare
  workspace_id_value uuid := 'f6dd1805-9c37-5ff2-9856-56a7abd8cff0';
  nordnet_kf_id uuid;
  seb_company_id uuid;
  business_expenses_id uuid := 'b3abd47f-b019-4e0a-8446-447c7e8be79f';
begin
  select id into strict nordnet_kf_id
  from public.accounts
  where workspace_id = workspace_id_value and name = 'Nordnet KF';

  select id into strict seb_company_id
  from public.accounts
  where workspace_id = workspace_id_value and name = 'SEB Företag';

  if not exists (
    select 1
    from public.transactions
    where workspace_id = workspace_id_value
      and id = '16877a3b-e282-42aa-a016-d7d8bda79b3c'
      and account_id = seb_company_id
      and transaction_date = date '2023-11-29'
      and transaction_type = 'income'
      and amount_minor = 431587
      and category_id is null
  ) then
    raise exception 'The unchanged SEK 4,315.87 Nordnet receipt was not found.';
  end if;

  if not exists (
    select 1
    from public.transactions
    where workspace_id = workspace_id_value
      and id = '52b9542d-d7a2-4bb6-aa40-7c056f7bbffc'
      and account_id = seb_company_id
      and transaction_date = date '2024-01-20'
      and transaction_type = 'expense'
      and amount_minor = 3600980
      and category_id is null
  ) then
    raise exception 'The unchanged Citadell liquidation expense was not found.';
  end if;

  update public.transactions
  set account_id = nordnet_kf_id,
      destination_account_id = seb_company_id,
      destination_amount_minor = 431587,
      transaction_type = 'transfer',
      category_id = null,
      payee_id = null,
      debtor_id = null,
      payee_name = null,
      memo = 'Final liquidation proceeds after tax',
      legacy_uncategorized = false,
      legacy_missing_payee = false
  where workspace_id = workspace_id_value
    and id = '16877a3b-e282-42aa-a016-d7d8bda79b3c';

  update public.transactions
  set category_id = business_expenses_id
  where workspace_id = workspace_id_value
    and id = '52b9542d-d7a2-4bb6-aa40-7c056f7bbffc';
end;
$$;

commit;
