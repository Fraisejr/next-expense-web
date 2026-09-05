begin;

-- Convert the legacy "Reconciliation difference" entries that were used to
-- bring investment accounts back to their observed market value. Each new
-- checkpoint is the account's calculated closing balance on the original date,
-- so converting the row does not change historical or current balances.
create temporary table market_valuation_candidates on commit drop as
select t.id, t.account_id, t.transaction_date
from public.transactions t
join public.accounts a on a.id = t.account_id
where t.transaction_type in ('income', 'expense')
  and (
    lower(coalesce(t.memo, '')) like '%reconcil%'
    or lower(coalesce(t.payee_name, '')) like '%reconcil%'
  )
  and (a.investment or a.name in ('eToro', 'Revolut Flexible USD'));

do $$
declare
  candidate_count integer;
begin
  select count(*) into candidate_count from market_valuation_candidates;
  if candidate_count <> 89 then
    raise exception 'Expected 89 legacy market valuations, found %', candidate_count;
  end if;

  if exists (
    select 1
    from market_valuation_candidates
    group by account_id, transaction_date
    having count(*) > 1
  ) then
    raise exception 'More than one market valuation exists for an account on the same date';
  end if;
end
$$;

create temporary table affected_accounts on commit drop as
select distinct account_id from market_valuation_candidates;

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
end
$$;

update public.transactions t
set
  transaction_type = 'balance_adjustment',
  amount_minor = 0,
  destination_amount_minor = 0,
  category_id = null,
  payee_id = null,
  debtor_id = null,
  payee_name = null,
  balance_checkpoint_minor = daily.balance_minor,
  adjustment_reason = 'market_valuation',
  source_timestamp = (t.transaction_date::text || ' 23:59:59+00')::timestamptz,
  updated_at = now()
from market_valuation_candidates candidate
join daily_balances_before daily
  on daily.account_id = candidate.account_id
 and daily.transaction_date = candidate.transaction_date
where t.id = candidate.id;

create temporary table balances_after (
  account_id uuid primary key,
  balance_minor bigint not null
) on commit drop;

create temporary table daily_balances_after (
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

      insert into daily_balances_after(account_id, transaction_date, balance_minor)
      values (account_record.account_id, event_record.transaction_date, running_balance)
      on conflict (account_id, transaction_date)
      do update set balance_minor = excluded.balance_minor;
    end loop;

    insert into balances_after(account_id, balance_minor)
    values (account_record.account_id, running_balance);
  end loop;
end
$$;

do $$
begin
  if exists (
    select 1
    from balances_before before_balance
    join balances_after after_balance using (account_id)
    where before_balance.balance_minor <> after_balance.balance_minor
  ) then
    raise exception 'Market valuation conversion changed a current account balance';
  end if;

  if exists (
    select 1
    from market_valuation_candidates candidate
    join daily_balances_before before_balance
      on before_balance.account_id = candidate.account_id
     and before_balance.transaction_date = candidate.transaction_date
    join daily_balances_after after_balance
      on after_balance.account_id = candidate.account_id
     and after_balance.transaction_date = candidate.transaction_date
    where before_balance.balance_minor <> after_balance.balance_minor
  ) then
    raise exception 'Market valuation conversion changed a historical checkpoint balance';
  end if;

  if (select count(*) from public.transactions t join market_valuation_candidates c on c.id = t.id
      where t.transaction_type = 'balance_adjustment'
        and t.adjustment_reason = 'market_valuation'
        and t.balance_checkpoint_minor is not null
        and t.category_id is null
        and t.payee_id is null) <> 89 then
    raise exception 'Not all market valuations were converted correctly';
  end if;
end
$$;

commit;
