begin;

create temporary table savings_goal_assignments (
  transaction_id uuid primary key,
  category_id uuid not null
) on commit drop;

-- Apartment purchase, renovations, fixed improvements, appliances, and
-- initial furnishings.
insert into savings_goal_assignments (transaction_id, category_id)
select transaction_id, '0827567c-8a00-4412-9ecc-a724be94b055'::uuid
from unnest(array[
  '0cb087ca-67cb-4b40-a937-1d6fc2d562ba'::uuid,
  '62b3be45-4f99-480e-aa8b-53e304a1b5f8'::uuid,
  '21b8985d-745a-49d5-8f4a-813f326504ff'::uuid,
  '4a7a91fa-a2e1-4f25-b32e-47972ac75072'::uuid,
  'f50379e1-a204-4652-9ddf-9116429e6b41'::uuid,
  '3695ca42-eb88-471d-845b-c7250ce620a3'::uuid,
  '64d628eb-f1ee-4880-b601-3da3c20056f2'::uuid,
  '98586fd1-ef36-484c-81d7-dbe42d88fdda'::uuid,
  '3f772641-3235-44ec-97e8-e877862b394b'::uuid,
  '7129c5a0-ddc8-4f09-a559-7bbaf12a78d6'::uuid,
  '58c3718e-0906-423c-8c77-aa6d1f73ef53'::uuid,
  'a41fb379-792b-40b0-9ef6-2d89ccf27735'::uuid,
  'dfb8875f-14a2-4aa1-ac10-bf0145d596eb'::uuid,
  '789966c8-9082-4f68-b574-2af42a3568ec'::uuid,
  'd951910b-80e5-4752-af0f-33d204244002'::uuid,
  'e158fa5d-2bd9-4b96-8887-c1aadaafa35a'::uuid,
  'c9e4bd3d-f7cd-4094-a292-171764338f65'::uuid,
  '8ed363ea-d467-49a0-84fa-215af9203920'::uuid,
  '83f8f780-101a-4659-9f05-e2b4b764155d'::uuid
]) as transaction_id;

-- Hair-transplant payments.
insert into savings_goal_assignments (transaction_id, category_id)
select transaction_id, '3569b111-5b0c-40e9-bf06-06f9ce5b9c08'::uuid
from unnest(array[
  '119dd5a2-ee2a-4a76-b5fe-33b075dbc20e'::uuid,
  '1e65a28c-bba4-42ba-a375-ce56d4808fac'::uuid,
  '289df4f5-2f1a-40d5-b8f8-b683b48c9c18'::uuid
]) as transaction_id;

insert into savings_goal_assignments (transaction_id, category_id) values
  ('b426a0ba-6116-44d5-8804-a3f1eac00329', '8e2daec1-4767-4702-9048-6947c82828e1'), -- Clintu: Cleaning
  ('c0abf40c-a8c7-4b5a-866b-8d01efaf6066', 'a6b9481e-3126-4b07-afb8-a22a03953d1b'), -- Degiro reconciliation
  ('4441eee4-c805-487a-8895-7a5b17b5074f', '1614f4d7-38b5-4392-a4ac-1736c902721a'); -- Returned rental deposit

-- Everything else except the retained Cash reconciliation difference is a
-- household or personal purchase, including ATM fees and the Amazon hammer.
insert into savings_goal_assignments (transaction_id, category_id)
select transaction.id, '3d57c0aa-4c68-4657-84bb-81d14c8c3801'::uuid
from public.transactions transaction
where transaction.category_id = 'bd532947-bc66-4606-b5e2-b72ab87b9b22'
  and transaction.id <> '602b0e02-a264-4365-814d-d21fd4c672be'
  and not exists (
    select 1
    from savings_goal_assignments assignment
    where assignment.transaction_id = transaction.id
  );

do $$
begin
  if (select count(*) from public.transactions where category_id = 'bd532947-bc66-4606-b5e2-b72ab87b9b22') <> 46 then
    raise exception 'Expected 46 Savings goals transactions before reclassification';
  end if;

  if (select count(*) from savings_goal_assignments) <> 45 then
    raise exception 'Expected 45 Savings goals assignments';
  end if;

  if (select count(*) from savings_goal_assignments where category_id = '0827567c-8a00-4412-9ecc-a724be94b055') <> 19 then
    raise exception 'Expected 19 Home repairs and investments assignments';
  end if;

  if (select count(*) from savings_goal_assignments where category_id = '3d57c0aa-4c68-4657-84bb-81d14c8c3801') <> 20 then
    raise exception 'Expected 20 Shopping assignments';
  end if;

  if (
    select count(*)
    from public.categories category
    where category.id in (
      '0827567c-8a00-4412-9ecc-a724be94b055',
      '3d57c0aa-4c68-4657-84bb-81d14c8c3801',
      '3569b111-5b0c-40e9-bf06-06f9ce5b9c08',
      '8e2daec1-4767-4702-9048-6947c82828e1',
      'a6b9481e-3126-4b07-afb8-a22a03953d1b',
      '1614f4d7-38b5-4392-a4ac-1736c902721a'
    )
      and category.hidden = false
  ) <> 6 then
    raise exception 'One or more active target categories were not found';
  end if;
end $$;

update public.transactions transaction
set category_id = assignment.category_id,
    memo = case
      when transaction.id = '4441eee4-c805-487a-8895-7a5b17b5074f' then 'Return of rental deposit'
      else transaction.memo
    end,
    updated_at = now()
from savings_goal_assignments assignment
where transaction.id = assignment.transaction_id;

do $$
begin
  if (
    select count(*)
    from public.transactions
    where category_id = 'bd532947-bc66-4606-b5e2-b72ab87b9b22'
  ) <> 1 then
    raise exception 'Expected one retained Savings goals transaction';
  end if;

  if not exists (
    select 1
    from public.transactions
    where id = '602b0e02-a264-4365-814d-d21fd4c672be'
      and category_id = 'bd532947-bc66-4606-b5e2-b72ab87b9b22'
  ) then
    raise exception 'The Cash reconciliation difference was not retained';
  end if;
end $$;

commit;
