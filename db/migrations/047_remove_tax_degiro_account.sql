begin;

do $$
declare
  workspace_id_value uuid := 'f6dd1805-9c37-5ff2-9856-56a7abd8cff0';
  tax_degiro_account_id uuid := '1d8e5ec6-f8d8-4499-948e-d72421975d5b';
  deleted_transaction_count integer;
  deleted_account_count integer;
begin
  if not exists (
    select 1
    from public.accounts
    where workspace_id = workspace_id_value
      and id = tax_degiro_account_id
      and name = 'Tax Degiro'
      and currency = 'EUR'
      and closed
  ) then
    raise exception 'The unchanged closed Tax Degiro account was not found.';
  end if;

  if (
    select count(*)
    from public.transactions
    where workspace_id = workspace_id_value
      and (account_id = tax_degiro_account_id or destination_account_id = tax_degiro_account_id)
  ) <> 5 then
    raise exception 'Expected exactly five Tax Degiro transactions.';
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
      and account_id = tax_degiro_account_id
  ) <> 0 then
    raise exception 'Tax Degiro does not have the expected zero balance.';
  end if;

  if exists (
    select 1
    from public.transactions
    where workspace_id = workspace_id_value
      and destination_account_id = tax_degiro_account_id
  ) then
    raise exception 'Tax Degiro unexpectedly has incoming transfers.';
  end if;

  update public.payees
  set default_account_id = null,
      updated_at = now()
  where workspace_id = workspace_id_value
    and default_account_id = tax_degiro_account_id;

  delete from public.transactions
  where workspace_id = workspace_id_value
    and account_id = tax_degiro_account_id;

  get diagnostics deleted_transaction_count = row_count;
  if deleted_transaction_count <> 5 then
    raise exception 'Expected to delete five Tax Degiro transactions, deleted %.', deleted_transaction_count;
  end if;

  delete from public.accounts
  where workspace_id = workspace_id_value
    and id = tax_degiro_account_id;

  get diagnostics deleted_account_count = row_count;
  if deleted_account_count <> 1 then
    raise exception 'Expected to delete the Tax Degiro account, deleted %.', deleted_account_count;
  end if;

  if not exists (
    select 1
    from public.accounts
    where workspace_id = workspace_id_value
      and id = 'dc78b9fe-0ae1-4137-87d3-9a35941edebe'
      and name = 'Degiro'
  ) then
    raise exception 'The real Degiro investment account was not preserved.';
  end if;
end;
$$;

commit;
