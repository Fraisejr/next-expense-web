begin;

do $$
declare
  workspace_id_value constant uuid := 'f6dd1805-9c37-5ff2-9856-56a7abd8cff0';
  other_income_id uuid;
  revenue_id uuid;
  candidate_ids constant uuid[] := array[
    'd5d88c1d-ee3d-4438-9f4d-39b903a79e42',
    '40314ffe-9760-4e1e-ba63-9f3f0468bfcf',
    '875541c0-3052-4d7f-9767-a1e186f02b02',
    'b1ebe16d-2242-46c1-a9d1-cbbe9d77dd0f',
    'dcc61342-c62a-4fea-9df7-1431afdc45a0',
    '82725186-ff20-447e-8ba1-78b1f77853bf',
    '09265c31-cbbf-46d4-98c4-32a1bc5cba47',
    '20d11707-aa5d-47f4-b3a4-65108f5d7539',
    '46dca51d-077d-4481-8e52-17287937efe7',
    'defe982f-2b30-4fb3-b249-e75cb94f3aee',
    '05e7201f-a946-483a-b847-3eda5d5d27aa',
    '5a843217-284d-4f1e-9d6d-4e2291f11fdb',
    'f47f7127-787d-41b3-9d87-c9bbb49c2888',
    '517d44b5-a3d1-4073-b0cd-cb11bf18169c',
    '0e05a733-02e7-4359-8150-d17bccbf430f',
    '5f75c0f0-0686-4094-87d6-130840f8713a',
    'bfb0323d-eb37-48f8-bb2a-fecfefc73db6',
    'd54a48a7-9f16-4aeb-a4be-ffabb4640836',
    '6a1a0d99-fbea-4d66-b90e-ed024def2123',
    'ac030c4d-33eb-4a77-9f40-aa3afc61928d',
    '7caf46a0-ffa3-45c0-a5eb-289f168553d2',
    'c6340c9d-0428-4091-81e1-efb6deb85698',
    '016ae013-4aec-4530-8ccc-487aa17e426f',
    '6137ea05-9da5-462c-9712-05ce3064b99e',
    'f9e6ced7-c356-4440-8e13-804fcc0d5c1f',
    '6668e5c8-da3b-4a35-9328-d4321944a894',
    'd517919a-fcf8-4aa1-add3-5e573a6c8074'
  ];
  candidate_count integer;
  business_expense_count integer;
begin
  select id into strict other_income_id
  from public.categories
  where workspace_id = workspace_id_value
    and name = 'Other income'
    and category_type = 'Income'
    and not hidden;

  select id into strict revenue_id
  from public.categories
  where workspace_id = workspace_id_value
    and name = 'Revenue'
    and category_type = 'Income'
    and not hidden;

  select count(*), count(*) filter (where category.name = 'Business expenses')
  into candidate_count, business_expense_count
  from public.transactions transaction
  join public.categories category
    on category.workspace_id = transaction.workspace_id
   and category.id = transaction.category_id
  where transaction.workspace_id = workspace_id_value
    and transaction.id = any(candidate_ids)
    and transaction.transaction_type = 'income';

  if candidate_count <> 27 then
    raise exception 'Expected 27 asset-sale income transactions, found %.', candidate_count;
  end if;

  if business_expense_count <> 2 then
    raise exception 'Expected 2 asset sales reducing Business expenses, found %.', business_expense_count;
  end if;

  update public.transactions transaction
  set category_id = case
        when category.name = 'Business expenses' then revenue_id
        else other_income_id
      end,
      updated_at = now()
  from public.categories category
  where transaction.workspace_id = workspace_id_value
    and transaction.id = any(candidate_ids)
    and category.workspace_id = transaction.workspace_id
    and category.id = transaction.category_id;

  if (select count(*) from public.transactions
      where workspace_id = workspace_id_value
        and id = any(candidate_ids)
        and category_id = revenue_id) <> 2 then
    raise exception 'Asset-sale Revenue classification did not produce 2 transactions.';
  end if;

  if (select count(*) from public.transactions
      where workspace_id = workspace_id_value
        and id = any(candidate_ids)
        and category_id = other_income_id) <> 25 then
    raise exception 'Asset-sale Other income classification did not produce 25 transactions.';
  end if;
end;
$$;

commit;
