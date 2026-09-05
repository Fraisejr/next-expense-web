begin;

create temporary table inspiraeon_category_assignments (
  transaction_id uuid primary key,
  category_id uuid not null
) on commit drop;

insert into inspiraeon_category_assignments (transaction_id, category_id)
select
  transaction.id,
  case
    when lower(coalesce(payee.name, transaction.payee_name, '')) in (
      'agencia tributaria inspiraeon',
      'hacienda'
    ) then '0c566ab6-117a-4ad0-8425-8c27b02f616c'::uuid
    when lower(coalesce(payee.name, transaction.payee_name, '')) in (
      'air france',
      'arlanda express',
      'bolt',
      'booking',
      'cabify',
      'dsb',
      'elite hotel esplanade',
      'hilton',
      'hotel rex',
      'parking',
      'sas',
      'sj',
      'taxi',
      'uber',
      'village hotels',
      'vueling'
    ) then '07c68eaa-6177-4c40-9a39-62db574f3b30'::uuid
    else 'b3abd47f-b019-4e0a-8446-447c7e8be79f'::uuid
  end
from public.transactions transaction
join public.accounts account
  on account.workspace_id = transaction.workspace_id
 and account.id = transaction.account_id
left join public.payees payee
  on payee.workspace_id = transaction.workspace_id
 and payee.id = transaction.payee_id
where account.id = '27df283c-fefa-4c8c-afcb-eb0b2c405e11'
  and account.name = 'Revolut Inspiraeon'
  and transaction.category_id is null
  and transaction.transaction_type in ('expense', 'income');

do $$
begin
  if (select count(*) from inspiraeon_category_assignments) <> 93 then
    raise exception 'Expected 93 uncategorized Revolut Inspiraeon transactions';
  end if;

  if (select count(*) from inspiraeon_category_assignments where category_id = '07c68eaa-6177-4c40-9a39-62db574f3b30') <> 52 then
    raise exception 'Expected 52 Travel expenses assignments';
  end if;

  if (select count(*) from inspiraeon_category_assignments where category_id = '0c566ab6-117a-4ad0-8425-8c27b02f616c') <> 9 then
    raise exception 'Expected 9 Taxes & Social charges assignments';
  end if;

  if (select count(*) from inspiraeon_category_assignments where category_id = 'b3abd47f-b019-4e0a-8446-447c7e8be79f') <> 32 then
    raise exception 'Expected 32 Business expenses assignments';
  end if;

  if (
    select count(*)
    from public.categories category
    where category.id in (
      '07c68eaa-6177-4c40-9a39-62db574f3b30',
      '0c566ab6-117a-4ad0-8425-8c27b02f616c',
      'b3abd47f-b019-4e0a-8446-447c7e8be79f'
    )
      and category.hidden = false
  ) <> 3 then
    raise exception 'One or more active target categories were not found';
  end if;
end $$;

update public.transactions transaction
set category_id = assignment.category_id,
    updated_at = now()
from inspiraeon_category_assignments assignment
where transaction.id = assignment.transaction_id;

do $$
begin
  if exists (
    select 1
    from public.transactions transaction
    join public.accounts account
      on account.workspace_id = transaction.workspace_id
     and account.id = transaction.account_id
    where account.id = '27df283c-fefa-4c8c-afcb-eb0b2c405e11'
      and transaction.category_id is null
      and transaction.transaction_type in ('expense', 'income')
  ) then
    raise exception 'Some Revolut Inspiraeon transactions remain uncategorized';
  end if;
end $$;

commit;
