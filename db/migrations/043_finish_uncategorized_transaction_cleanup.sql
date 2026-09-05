begin;

create temporary table final_adjustment_candidates (
  id uuid primary key,
  adjustment_reason text not null,
  replacement_memo text not null
) on commit drop;

insert into final_adjustment_candidates (id, adjustment_reason, replacement_memo) values
  ('77ca4baa-640b-4931-a0f3-84535c943a1b', 'market_valuation', 'Capital-insurance gain reflected in market value'),
  ('d16760c9-ea42-4abc-93c1-4f002c86f34d', 'liability_adjustment', 'Mortgage principal balance after amortization'),
  ('c5afac98-b041-4671-9883-955bf06aaebf', 'liability_adjustment', 'Mortgage principal balance after amortization'),
  ('ed774053-c037-4126-8161-57f492379b4b', 'liability_adjustment', 'Mortgage principal balance after amortization'),
  ('67b5f0cf-9d08-44f6-a993-44fdaeeb1bb8', 'liability_adjustment', 'Mortgage principal balance after amortization'),
  ('30f511fa-b48a-490e-8b7a-6c9f952eb040', 'liability_adjustment', 'Mortgage principal balance after amortization'),
  ('cfe4e06c-4305-4c23-8bc9-a998ccd8cc71', 'liability_adjustment', 'Loan closing balance after final interest and early-repayment fees');

do $$
declare
  workspace_id_value uuid := 'f6dd1805-9c37-5ff2-9856-56a7abd8cff0';
begin
  if (
    select count(*)
    from public.transactions t
    join final_adjustment_candidates candidate on candidate.id = t.id
    where t.workspace_id = workspace_id_value
      and t.transaction_type in ('income', 'expense')
      and t.category_id is null
  ) <> 7 then
    raise exception 'The seven unchanged balance-only transactions were not found.';
  end if;

  if exists (
    select 1
    from public.transactions t
    join final_adjustment_candidates candidate on candidate.id = t.id
    join public.transactions existing
      on existing.workspace_id = t.workspace_id
     and existing.account_id = t.account_id
     and existing.transaction_date = t.transaction_date
     and existing.transaction_type = 'balance_adjustment'
  ) then
    raise exception 'An account already has a balance adjustment on a conversion date.';
  end if;

  if not exists (
    select 1
    from public.transactions
    where workspace_id = workspace_id_value
      and id = '5eba213b-00a7-4248-8af9-df85eb1d139d'
      and transaction_type = 'income'
      and amount_minor = 25000
      and category_id is null
      and memo = 'Deposit'
  ) then
    raise exception 'The unchanged Tesla deposit was not found.';
  end if;

  if not exists (
    select 1
    from public.transactions
    where workspace_id = workspace_id_value
      and id = '31065913-e6dd-4998-a4a0-24177533012c'
      and transaction_type = 'balance_adjustment'
      and balance_checkpoint_minor = 4227000
  ) then
    raise exception 'The Tesla acquisition-value checkpoint was not found.';
  end if;
end;
$$;

create temporary table affected_accounts on commit drop as
select distinct t.account_id
from public.transactions t
join final_adjustment_candidates candidate on candidate.id = t.id
union
select account_id
from public.transactions
where id = '5eba213b-00a7-4248-8af9-df85eb1d139d';

create temporary table balances_before (
  account_id uuid primary key,
  balance_minor bigint not null
) on commit drop;

create temporary table daily_balances_before (
  account_id uuid not null,
  transaction_date date not null,
  balance_minor bigint not null,
  primary key (account_id, transaction_date)
) on commit drop;

do $$
declare
  account_record record;
  event_record record;
  running_balance bigint;
begin
  for account_record in select account_id from affected_accounts loop
    running_balance := 0;
    for event_record in
      select *
      from (
        select
          t.id,
          t.transaction_date,
          t.transaction_type as event_kind,
          t.balance_checkpoint_minor,
          case t.transaction_type
            when 'income' then t.amount_minor
            when 'expense' then -t.amount_minor
            when 'opening_balance' then t.amount_minor
            when 'transfer' then -t.amount_minor
            else 0
          end as delta_minor
        from public.transactions t
        where t.account_id = account_record.account_id

        union all

        select
          t.id,
          t.transaction_date,
          'transfer_destination' as event_kind,
          null::bigint as balance_checkpoint_minor,
          coalesce(nullif(t.destination_amount_minor, 0), t.amount_minor) as delta_minor
        from public.transactions t
        where t.transaction_type = 'transfer'
          and t.destination_account_id = account_record.account_id
      ) events
      order by
        transaction_date,
        case when event_kind = 'balance_adjustment' then 1 else 0 end,
        id
    loop
      if event_record.event_kind = 'balance_adjustment' then
        running_balance := event_record.balance_checkpoint_minor;
      else
        running_balance := running_balance + event_record.delta_minor;
      end if;

      insert into daily_balances_before(account_id, transaction_date, balance_minor)
      values (account_record.account_id, event_record.transaction_date, running_balance)
      on conflict (account_id, transaction_date)
      do update set balance_minor = excluded.balance_minor;
    end loop;

    insert into balances_before(account_id, balance_minor)
    values (account_record.account_id, running_balance);
  end loop;
end;
$$;

update public.transactions t
set transaction_type = 'balance_adjustment',
    amount_minor = 0,
    destination_amount_minor = 0,
    destination_account_id = null,
    category_id = null,
    payee_id = null,
    debtor_id = null,
    payee_name = null,
    balance_checkpoint_minor = daily.balance_minor,
    adjustment_reason = candidate.adjustment_reason,
    memo = candidate.replacement_memo,
    legacy_uncategorized = false,
    legacy_missing_payee = false,
    source_timestamp = (t.transaction_date::text || ' 23:59:59+00')::timestamptz,
    updated_at = now()
from final_adjustment_candidates candidate
join daily_balances_before daily
  on daily.transaction_date = (
    select transaction_date from public.transactions where id = candidate.id
  )
 and daily.account_id = (
    select account_id from public.transactions where id = candidate.id
  )
where t.id = candidate.id;

update public.transactions
set memo = 'Acquisition value · includes €250 deposit',
    updated_at = now()
where id = '31065913-e6dd-4998-a4a0-24177533012c';

delete from public.transactions
where id = '5eba213b-00a7-4248-8af9-df85eb1d139d';

update public.transactions
set category_id = '0827567c-8a00-4412-9ecc-a724be94b055',
    legacy_uncategorized = false,
    updated_at = now()
where id = '4e5b1c02-aa14-4fd5-8aa1-f577865b4710';

update public.transactions
set category_id = 'b3abd47f-b019-4e0a-8446-447c7e8be79f',
    legacy_uncategorized = false,
    updated_at = now()
where id = 'd5d88c1d-ee3d-4438-9f4d-39b903a79e42';

create temporary table balances_after (
  account_id uuid primary key,
  balance_minor bigint not null
) on commit drop;

do $$
declare
  account_record record;
  event_record record;
  running_balance bigint;
begin
  for account_record in select account_id from affected_accounts loop
    running_balance := 0;
    for event_record in
      select *
      from (
        select
          t.id,
          t.transaction_date,
          t.transaction_type as event_kind,
          t.balance_checkpoint_minor,
          case t.transaction_type
            when 'income' then t.amount_minor
            when 'expense' then -t.amount_minor
            when 'opening_balance' then t.amount_minor
            when 'transfer' then -t.amount_minor
            else 0
          end as delta_minor
        from public.transactions t
        where t.account_id = account_record.account_id

        union all

        select
          t.id,
          t.transaction_date,
          'transfer_destination' as event_kind,
          null::bigint as balance_checkpoint_minor,
          coalesce(nullif(t.destination_amount_minor, 0), t.amount_minor) as delta_minor
        from public.transactions t
        where t.transaction_type = 'transfer'
          and t.destination_account_id = account_record.account_id
      ) events
      order by
        transaction_date,
        case when event_kind = 'balance_adjustment' then 1 else 0 end,
        id
    loop
      if event_record.event_kind = 'balance_adjustment' then
        running_balance := event_record.balance_checkpoint_minor;
      else
        running_balance := running_balance + event_record.delta_minor;
      end if;
    end loop;

    insert into balances_after(account_id, balance_minor)
    values (account_record.account_id, running_balance);
  end loop;
end;
$$;

do $$
begin
  if exists (
    select 1
    from balances_before before_balance
    join balances_after after_balance using (account_id)
    where before_balance.balance_minor <> after_balance.balance_minor
  ) then
    raise exception 'The cleanup changed a current account balance.';
  end if;

  if (
    select count(*)
    from public.transactions t
    join final_adjustment_candidates candidate on candidate.id = t.id
    where t.transaction_type = 'balance_adjustment'
      and t.adjustment_reason = candidate.adjustment_reason
      and t.balance_checkpoint_minor is not null
      and t.category_id is null
      and t.payee_id is null
  ) <> 7 then
    raise exception 'Not all seven balance-only transactions were converted.';
  end if;

  if exists (
    select 1
    from public.transactions
    where transaction_type in ('income', 'expense')
      and category_id is null
  ) then
    raise exception 'Uncategorized income or expense transactions remain.';
  end if;
end;
$$;

commit;
