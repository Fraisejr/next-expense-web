begin;

do $$
declare
  workspace_id_value uuid := 'f6dd1805-9c37-5ff2-9856-56a7abd8cff0';
  revolut_eur_id uuid := '269d68be-cc85-46bb-a563-b2d7079c4371';
  going_out_id uuid := '1cf959de-9d9d-4155-a7e1-e3cb7a32171d';
  expected_count integer;
  updated_count integer;
begin
  -- Merchants that do not already exist in the payee register.
  insert into public.payees (id, workspace_id, name, default_account_id, default_category_id)
  values
    ('c3eaa82f-227b-4ce2-965d-73d0aa736445', workspace_id_value, 'Centris Events', revolut_eur_id, going_out_id),
    ('9f55fd95-1df4-4cc2-bfb2-8ebc48407ffc', workspace_id_value, 'Passeig de Garcia Fària', revolut_eur_id, going_out_id),
    ('6e3b820d-7fdb-41a1-8050-f239c40704e2', workspace_id_value, 'Vencafesa', revolut_eur_id, going_out_id),
    ('5c3e317b-c24a-4972-9511-5a02217018fe', workspace_id_value, 'Savannah', revolut_eur_id, going_out_id),
    ('0defc093-adab-43c7-afa3-ed9647f77ada', workspace_id_value, 'Farola', revolut_eur_id, going_out_id)
  on conflict (id) do nothing;

  -- Preserve the raw statement descriptions as aliases for the existing,
  -- friendlier payees used by the app.
  insert into public.payee_mappings (id, workspace_id, normalized_name, source_name, payee_id, match_type)
  values
    (md5(workspace_id_value::text || ':Postombud på Tempo Baggeby')::uuid, workspace_id_value, lower('Postombud på Tempo Baggeby'), 'Postombud på Tempo Baggeby', '27eb3a70-f3ee-48ff-acd6-a9c9a5e5c29d', 'exact'),
    (md5(workspace_id_value::text || ':hostgator.com')::uuid, workspace_id_value, lower('hostgator.com'), 'hostgator.com', '6fdd957e-1978-4ef9-a77f-e93018db0431', 'exact'),
    (md5(workspace_id_value::text || ':LloydsApotek Lidingö Larsberg')::uuid, workspace_id_value, lower('LloydsApotek Lidingö Larsberg'), 'LloydsApotek Lidingö Larsberg', '1632e68b-ae1e-4381-9c83-b052eb1f7a17', 'exact'),
    (md5(workspace_id_value::text || ':Silence.eco')::uuid, workspace_id_value, lower('Silence.eco'), 'Silence.eco', '3c0d19cc-30f8-4dd7-a86e-1d367a700700', 'exact'),
    (md5(workspace_id_value::text || ':Taxi Licencia 2651')::uuid, workspace_id_value, lower('Taxi Licencia 2651'), 'Taxi Licencia 2651', '52ca55ab-cfc6-4be3-ae8d-4a2ee8a35237', 'exact'),
    (md5(workspace_id_value::text || ':Chiringuito Bogatell')::uuid, workspace_id_value, lower('Chiringuito Bogatell'), 'Chiringuito Bogatell', 'bbee92b2-5471-4bda-b93f-756df8c066c4', 'exact'),
    (md5(workspace_id_value::text || ':Maa Supermercat')::uuid, workspace_id_value, lower('Maa Supermercat'), 'Maa Supermercat', 'a3866cda-ccee-4786-b096-cc8aa003bf2f', 'exact'),
    (md5(workspace_id_value::text || ':Nuevo Aroma Kaori')::uuid, workspace_id_value, lower('Nuevo Aroma Kaori'), 'Nuevo Aroma Kaori', '1bed3b87-a0d1-4f9a-98a6-760111e7e5ae', 'exact'),
    (md5(workspace_id_value::text || ':Nass 1994 SL')::uuid, workspace_id_value, lower('Nass 1994 SL'), 'Nass 1994 SL', '841884a1-4039-4a56-854a-0917d910c97c', 'exact'),
    (md5(workspace_id_value::text || ':McDonald''s')::uuid, workspace_id_value, lower('McDonald''s'), 'McDonald''s', 'b331a966-b0d8-4989-94a3-1fe1dd4bda13', 'exact'),
    (md5(workspace_id_value::text || ':Bar Bitácora')::uuid, workspace_id_value, lower('Bar Bitácora'), 'Bar Bitácora', 'fc7d595c-f59c-4c03-bea6-3d68eb3dd53d', 'exact')
  on conflict (workspace_id, source_name, payee_id) do nothing;

  with plan(transaction_id, expected_date, expected_amount_minor, payee_id) as (
    values
      ('84c0e1a3-f162-4e20-86ca-3fd550e3acc9'::uuid, date '2022-10-02', 1115::bigint, '27eb3a70-f3ee-48ff-acd6-a9c9a5e5c29d'::uuid),
      ('b3b9c364-fd04-4102-9408-dee54fe0c5bd'::uuid, date '2022-10-02', 1542::bigint, '6fdd957e-1978-4ef9-a77f-e93018db0431'::uuid),
      ('5bfec595-6660-4d77-9207-478f11a55a9f'::uuid, date '2022-10-02', 2817::bigint, '74822978-6e62-409c-bbd4-b5cff8a1a8f6'::uuid),
      ('5822b55e-e297-4b64-ac8b-46745140f23e'::uuid, date '2022-10-04', 590::bigint, 'd8b8bf07-2f6e-4a37-b640-e24e2967e0cf'::uuid),
      ('9394ac15-4482-4528-8e5f-626b0551d46b'::uuid, date '2022-10-04', 919::bigint, '1632e68b-ae1e-4381-9c83-b052eb1f7a17'::uuid),
      ('f8c865a5-ae02-4867-a817-ae18c4962e92'::uuid, date '2022-10-05', 361::bigint, '62554633-6eda-4b5c-93b4-74b1e7dfc8f0'::uuid),
      ('ff266572-aa4c-42e9-8e29-373fcdf2ff3a'::uuid, date '2022-10-05', 500::bigint, '27f98fe1-7b3f-4dea-8c01-1e70f06e3bab'::uuid),
      ('0b1d406e-4683-48b6-b70c-76c4a0bc0c1c'::uuid, date '2022-10-05', 1500::bigint, '3c0d19cc-30f8-4dd7-a86e-1d367a700700'::uuid),
      ('591a37f7-fdcf-4d3e-8a03-ff43c9708a83'::uuid, date '2022-10-05', 2939::bigint, '0f90f8ba-32f8-4cab-8734-d3acc561b3cf'::uuid),
      ('4a0992e0-19eb-42fe-8671-066a8078b676'::uuid, date '2022-10-06', 1722::bigint, '0f90f8ba-32f8-4cab-8734-d3acc561b3cf'::uuid),
      ('58558c86-0b28-4893-9618-a11eeaf599b1'::uuid, date '2022-10-08', 1029::bigint, '0f90f8ba-32f8-4cab-8734-d3acc561b3cf'::uuid),
      ('a7750176-5a25-47b8-88a4-dca0b73ad1cb'::uuid, date '2022-10-08', 2998::bigint, '6c006de7-4b99-496f-ac86-25fbd56f3484'::uuid),
      ('7d3ab269-f39a-431a-9117-4efcbd699131'::uuid, date '2022-10-08', 2999::bigint, '27f98fe1-7b3f-4dea-8c01-1e70f06e3bab'::uuid),
      ('4ef26dc4-9217-446b-8846-0a02f3e8bc86'::uuid, date '2022-10-09', 1550::bigint, '52ca55ab-cfc6-4be3-ae8d-4a2ee8a35237'::uuid),
      ('e762a8bd-233f-4ca8-9516-791b968f2b8b'::uuid, date '2022-10-09', 1700::bigint, '9f55fd95-1df4-4cc2-bfb2-8ebc48407ffc'::uuid),
      ('a3c95cdf-baa7-4a62-87c3-97feeefed98a'::uuid, date '2022-10-09', 2200::bigint, 'c3eaa82f-227b-4ce2-965d-73d0aa736445'::uuid),
      ('3872dd4c-4017-4f95-bffe-16c4632d00f9'::uuid, date '2022-10-10', 35::bigint, '02b4c138-706b-436b-a8ed-d6c48ac5264c'::uuid),
      ('c1e6dc58-72d1-4f2f-9188-26fe02235e4d'::uuid, date '2022-10-11', 2681::bigint, '0f90f8ba-32f8-4cab-8734-d3acc561b3cf'::uuid),
      ('bea0d989-77a5-4a3d-b8ab-f0e107a4591f'::uuid, date '2022-10-12', 180::bigint, 'a3866cda-ccee-4786-b096-cc8aa003bf2f'::uuid),
      ('9014bc8f-546a-4a49-8d52-749520c265fc'::uuid, date '2022-10-12', 350::bigint, 'bbee92b2-5471-4bda-b93f-756df8c066c4'::uuid),
      ('2de1279d-6ebc-48e1-9df7-b578f9d20d30'::uuid, date '2022-10-13', 2200::bigint, '1bed3b87-a0d1-4f9a-98a6-760111e7e5ae'::uuid),
      ('1fccad51-c762-4b4e-abb5-fe174cfd4466'::uuid, date '2022-10-14', 190::bigint, '6e3b820d-7fdb-41a1-8050-f239c40704e2'::uuid),
      ('aadd23a6-7173-4674-af20-94730d09ec06'::uuid, date '2022-10-14', 410::bigint, '841884a1-4039-4a56-854a-0917d910c97c'::uuid),
      ('83b2b9da-f024-479f-8952-ce091b215e51'::uuid, date '2022-10-14', 980::bigint, 'b331a966-b0d8-4989-94a3-1fe1dd4bda13'::uuid),
      ('6cc1bab7-5788-4c67-b96c-5efae9c8d549'::uuid, date '2022-10-15', 1600::bigint, 'fc7d595c-f59c-4c03-bea6-3d68eb3dd53d'::uuid),
      ('ca1ea753-dd5a-40f5-99b1-9827791a805d'::uuid, date '2022-10-15', 2850::bigint, '5c3e317b-c24a-4972-9511-5a02217018fe'::uuid),
      ('49fbd32e-a8d6-47f3-ac97-f421328c96f9'::uuid, date '2022-10-15', 3000::bigint, '0defc093-adab-43c7-afa3-ed9647f77ada'::uuid)
  )
  select count(*) into expected_count
  from plan
  join public.transactions t
    on t.id = plan.transaction_id
   and t.workspace_id = workspace_id_value
   and t.account_id = revolut_eur_id
   and t.transaction_type = 'expense'
   and t.transaction_date = plan.expected_date
   and t.amount_minor = plan.expected_amount_minor
   and t.payee_id is null;

  if expected_count <> 27 then
    raise exception 'Expected 27 unchanged Revolut expenses, found %.', expected_count;
  end if;

  with plan(transaction_id, payee_id) as (
    values
      ('84c0e1a3-f162-4e20-86ca-3fd550e3acc9'::uuid, '27eb3a70-f3ee-48ff-acd6-a9c9a5e5c29d'::uuid),
      ('b3b9c364-fd04-4102-9408-dee54fe0c5bd'::uuid, '6fdd957e-1978-4ef9-a77f-e93018db0431'::uuid),
      ('5bfec595-6660-4d77-9207-478f11a55a9f'::uuid, '74822978-6e62-409c-bbd4-b5cff8a1a8f6'::uuid),
      ('5822b55e-e297-4b64-ac8b-46745140f23e'::uuid, 'd8b8bf07-2f6e-4a37-b640-e24e2967e0cf'::uuid),
      ('9394ac15-4482-4528-8e5f-626b0551d46b'::uuid, '1632e68b-ae1e-4381-9c83-b052eb1f7a17'::uuid),
      ('f8c865a5-ae02-4867-a817-ae18c4962e92'::uuid, '62554633-6eda-4b5c-93b4-74b1e7dfc8f0'::uuid),
      ('ff266572-aa4c-42e9-8e29-373fcdf2ff3a'::uuid, '27f98fe1-7b3f-4dea-8c01-1e70f06e3bab'::uuid),
      ('0b1d406e-4683-48b6-b70c-76c4a0bc0c1c'::uuid, '3c0d19cc-30f8-4dd7-a86e-1d367a700700'::uuid),
      ('591a37f7-fdcf-4d3e-8a03-ff43c9708a83'::uuid, '0f90f8ba-32f8-4cab-8734-d3acc561b3cf'::uuid),
      ('4a0992e0-19eb-42fe-8671-066a8078b676'::uuid, '0f90f8ba-32f8-4cab-8734-d3acc561b3cf'::uuid),
      ('58558c86-0b28-4893-9618-a11eeaf599b1'::uuid, '0f90f8ba-32f8-4cab-8734-d3acc561b3cf'::uuid),
      ('a7750176-5a25-47b8-88a4-dca0b73ad1cb'::uuid, '6c006de7-4b99-496f-ac86-25fbd56f3484'::uuid),
      ('7d3ab269-f39a-431a-9117-4efcbd699131'::uuid, '27f98fe1-7b3f-4dea-8c01-1e70f06e3bab'::uuid),
      ('4ef26dc4-9217-446b-8846-0a02f3e8bc86'::uuid, '52ca55ab-cfc6-4be3-ae8d-4a2ee8a35237'::uuid),
      ('e762a8bd-233f-4ca8-9516-791b968f2b8b'::uuid, '9f55fd95-1df4-4cc2-bfb2-8ebc48407ffc'::uuid),
      ('a3c95cdf-baa7-4a62-87c3-97feeefed98a'::uuid, 'c3eaa82f-227b-4ce2-965d-73d0aa736445'::uuid),
      ('3872dd4c-4017-4f95-bffe-16c4632d00f9'::uuid, '02b4c138-706b-436b-a8ed-d6c48ac5264c'::uuid),
      ('c1e6dc58-72d1-4f2f-9188-26fe02235e4d'::uuid, '0f90f8ba-32f8-4cab-8734-d3acc561b3cf'::uuid),
      ('bea0d989-77a5-4a3d-b8ab-f0e107a4591f'::uuid, 'a3866cda-ccee-4786-b096-cc8aa003bf2f'::uuid),
      ('9014bc8f-546a-4a49-8d52-749520c265fc'::uuid, 'bbee92b2-5471-4bda-b93f-756df8c066c4'::uuid),
      ('2de1279d-6ebc-48e1-9df7-b578f9d20d30'::uuid, '1bed3b87-a0d1-4f9a-98a6-760111e7e5ae'::uuid),
      ('1fccad51-c762-4b4e-abb5-fe174cfd4466'::uuid, '6e3b820d-7fdb-41a1-8050-f239c40704e2'::uuid),
      ('aadd23a6-7173-4674-af20-94730d09ec06'::uuid, '841884a1-4039-4a56-854a-0917d910c97c'::uuid),
      ('83b2b9da-f024-479f-8952-ce091b215e51'::uuid, 'b331a966-b0d8-4989-94a3-1fe1dd4bda13'::uuid),
      ('6cc1bab7-5788-4c67-b96c-5efae9c8d549'::uuid, 'fc7d595c-f59c-4c03-bea6-3d68eb3dd53d'::uuid),
      ('ca1ea753-dd5a-40f5-99b1-9827791a805d'::uuid, '5c3e317b-c24a-4972-9511-5a02217018fe'::uuid),
      ('49fbd32e-a8d6-47f3-ac97-f421328c96f9'::uuid, '0defc093-adab-43c7-afa3-ed9647f77ada'::uuid)
  )
  update public.transactions t
  set payee_id = plan.payee_id,
      payee_name = null
  from plan
  where t.workspace_id = workspace_id_value
    and t.id = plan.transaction_id;

  get diagnostics updated_count = row_count;
  if updated_count <> 27 then
    raise exception 'Expected to update 27 Revolut expenses, updated %.', updated_count;
  end if;
end;
$$;

commit;
