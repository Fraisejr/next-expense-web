begin;

do $$
declare
  workspace_id_value uuid := 'f6dd1805-9c37-5ff2-9856-56a7abd8cff0';
  business_expenses_id uuid := 'b3abd47f-b019-4e0a-8446-447c7e8be79f';
  travel_expenses_id uuid := '07c68eaa-6177-4c40-9a39-62db574f3b30';
  taxes_id uuid := '0c566ab6-117a-4ad0-8425-8c27b02f616c';
  business_count integer;
  travel_count integer;
  tax_count integer;
  updated_count integer;
begin
  with eligible as (
    select
      t.id,
      case
        when a.name = 'SEB Företag' and p.name = 'Skattekonto' then taxes_id
        when a.name = 'SEB Företag' and p.name in ('Air Serbia', 'SAS', 'Vueling') then travel_expenses_id
        when (
          a.name = 'SEB Företag'
          and p.name in (
            'SEB', 'Tre Företag', 'Fortnox', 'Apple', 'Apple Store',
            'Amazon', 'Nespresso', 'Netonnet', 'GoDaddy', 'Talenom',
            'eDeklarera', 'Trygghansa'
          )
        ) or (a.name = 'Interactive Brokers' and p.name = 'Interactive Brokers') then business_expenses_id
      end as category_id
    from public.transactions t
    join public.accounts a on a.id = t.account_id
    join public.payees p on p.id = t.payee_id
    where t.workspace_id = workspace_id_value
      and t.transaction_type in ('expense', 'income')
      and t.category_id is null
  )
  select
    count(*) filter (where category_id = business_expenses_id),
    count(*) filter (where category_id = travel_expenses_id),
    count(*) filter (where category_id = taxes_id)
  into business_count, travel_count, tax_count
  from eligible;

  if business_count <> 41 or travel_count <> 4 or tax_count <> 14 then
    raise exception
      'Expected 41 business, 4 travel, and 14 tax transactions; found %, %, and %.',
      business_count, travel_count, tax_count;
  end if;

  with eligible as (
    select
      t.id,
      case
        when a.name = 'SEB Företag' and p.name = 'Skattekonto' then taxes_id
        when a.name = 'SEB Företag' and p.name in ('Air Serbia', 'SAS', 'Vueling') then travel_expenses_id
        when (
          a.name = 'SEB Företag'
          and p.name in (
            'SEB', 'Tre Företag', 'Fortnox', 'Apple', 'Apple Store',
            'Amazon', 'Nespresso', 'Netonnet', 'GoDaddy', 'Talenom',
            'eDeklarera', 'Trygghansa'
          )
        ) or (a.name = 'Interactive Brokers' and p.name = 'Interactive Brokers') then business_expenses_id
      end as category_id
    from public.transactions t
    join public.accounts a on a.id = t.account_id
    join public.payees p on p.id = t.payee_id
    where t.workspace_id = workspace_id_value
      and t.transaction_type in ('expense', 'income')
      and t.category_id is null
  )
  update public.transactions t
  set category_id = eligible.category_id
  from eligible
  where t.id = eligible.id
    and eligible.category_id is not null;

  get diagnostics updated_count = row_count;
  if updated_count <> 59 then
    raise exception 'Expected to update 59 transactions, updated %.', updated_count;
  end if;
end;
$$;

commit;
