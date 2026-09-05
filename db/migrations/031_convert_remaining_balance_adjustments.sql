begin;

-- Convert the remaining legacy reconciliation rows whose purpose is clear.
-- Identifiable income/expenses and the ambiguous final car-loan entry are
-- deliberately left untouched.
create temporary table remaining_adjustment_candidates on commit drop as
select
  t.id,
  t.account_id,
  t.transaction_date,
  case
    when a.name = 'Apartment Calvell' then 'asset_valuation'
    when a.name in ('Mortgage', 'Car loan') then 'liability_adjustment'
    else 'reconciliation'
  end as adjustment_reason
from public.transactions t
join public.accounts a on a.id = t.account_id
left join public.payees p on p.id = t.payee_id
where t.transaction_type in ('income', 'expense')
  and (
    lower(coalesce(t.memo, '')) like '%reconcil%'
    or lower(coalesce(t.payee_name, '')) like '%reconcil%'
  )
  and (
    a.name = 'Apartment Calvell'
    or a.name = 'Mortgage'
    or (a.name = 'Car loan' and t.memo = 'Reconciliation difference')
    or (
      a.name in ('Revolut EUR', 'Cash', 'Handelsbanken', 'ING')
      and coalesce(p.name, t.payee_name, '') not in ('Alex', 'Restaurant')
    )
  );

do $$
begin
  if (select count(*) from remaining_adjustment_candidates) <> 36 then
    raise exception 'Expected 36 remaining balance adjustments, found %',
      (select count(*) from remaining_adjustment_candidates);
  end if;

  if (select count(*) from remaining_adjustment_candidates where adjustment_reason = 'asset_valuation') <> 1
    or (select count(*) from remaining_adjustment_candidates where adjustment_reason = 'liability_adjustment') <> 20
    or (select count(*) from remaining_adjustment_candidates where adjustment_reason = 'reconciliation') <> 15 then
    raise exception 'The adjustment-reason breakdown does not match the reviewed set';
  end if;

  if exists (
    select 1
    from remaining_adjustment_candidates
    group by account_id, transaction_date
    having count(*) > 1
  ) then
    raise exception 'More than one candidate exists for an account on the same date';
  end if;

  if exists (
    select 1
    from remaining_adjustment_candidates candidate
    join public.transactions existing
      on existing.account_id = candidate.account_id
     and existing.transaction_date = candidate.transaction_date
     and existing.transaction_type = 'balance_adjustment'
  ) then
    raise exception 'An account already has a balance adjustment on a candidate date';
  end if;
end
$$;

create temporary table affected_accounts on commit drop as
select distinct account_id from remaining_adjustment_candidates;

-- These accounts have no earlier checkpoints, so their original daily closing
-- balances are the cumulative total of their transaction effects.
do $$
begin
  if exists (
    select 1
    from public.transactions t
    join affected_accounts a on a.account_id = t.account_id
    where t.transaction_type = 'balance_adjustment'
  ) then
    raise exception 'An affected account already contains a balance adjustment';
  end if;
end
$$;

create temporary table account_events_before on commit drop as
select account_id, transaction_date, sum(delta_minor)::bigint as delta_minor
from (
  select
    t.account_id,
    t.transaction_date,
    case t.transaction_type
      when 'income' then t.amount_minor
      when 'expense' then -t.amount_minor
      when 'opening_balance' then t.amount_minor
      when 'transfer' then -t.amount_minor
      else 0
    end as delta_minor
  from public.transactions t
  join affected_accounts a on a.account_id = t.account_id

  union all

  select
    t.destination_account_id as account_id,
    t.transaction_date,
    coalesce(nullif(t.destination_amount_minor, 0), t.amount_minor) as delta_minor
  from public.transactions t
  join affected_accounts a on a.account_id = t.destination_account_id
  where t.transaction_type = 'transfer'
) events
group by account_id, transaction_date;

create temporary table daily_balances_before on commit drop as
select
  account_id,
  transaction_date,
  sum(delta_minor) over (
    partition by account_id
    order by transaction_date
    rows between unbounded preceding and current row
  )::bigint as balance_minor
from account_events_before;

create temporary table balances_before on commit drop as
select distinct on (account_id) account_id, balance_minor
from daily_balances_before
order by account_id, transaction_date desc;

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
  adjustment_reason = candidate.adjustment_reason,
  source_timestamp = (t.transaction_date::text || ' 23:59:59+00')::timestamptz,
  updated_at = now()
from remaining_adjustment_candidates candidate
join daily_balances_before daily
  on daily.account_id = candidate.account_id
 and daily.transaction_date = candidate.transaction_date
where t.id = candidate.id;

create temporary table account_events_after on commit drop as
select account_id, transaction_date, sum(delta_minor)::bigint as delta_minor
from (
  select
    t.account_id,
    t.transaction_date,
    case t.transaction_type
      when 'income' then t.amount_minor
      when 'expense' then -t.amount_minor
      when 'opening_balance' then t.amount_minor
      when 'transfer' then -t.amount_minor
      else 0
    end as delta_minor
  from public.transactions t
  join affected_accounts a on a.account_id = t.account_id

  union all

  select
    t.destination_account_id as account_id,
    t.transaction_date,
    coalesce(nullif(t.destination_amount_minor, 0), t.amount_minor) as delta_minor
  from public.transactions t
  join affected_accounts a on a.account_id = t.destination_account_id
  where t.transaction_type = 'transfer'
) events
group by account_id, transaction_date;

create temporary table balances_after on commit drop as
select
  affected.account_id,
  (
    latest.balance_checkpoint_minor
    + coalesce(sum(events.delta_minor) filter (
        where events.transaction_date > latest.transaction_date
      ), 0)
  )::bigint as balance_minor
from affected_accounts affected
join lateral (
  select t.transaction_date, t.balance_checkpoint_minor
  from public.transactions t
  where t.account_id = affected.account_id
    and t.transaction_type = 'balance_adjustment'
  order by t.transaction_date desc, t.id desc
  limit 1
) latest on true
left join account_events_after events on events.account_id = affected.account_id
group by affected.account_id, latest.transaction_date, latest.balance_checkpoint_minor;

do $$
begin
  if exists (
    select 1
    from balances_before before_balance
    join balances_after after_balance using (account_id)
    where before_balance.balance_minor <> after_balance.balance_minor
  ) then
    raise exception 'The conversion changed a current account balance';
  end if;

  if exists (
    select 1
    from remaining_adjustment_candidates candidate
    join public.transactions t on t.id = candidate.id
    join daily_balances_before daily
      on daily.account_id = candidate.account_id
     and daily.transaction_date = candidate.transaction_date
    where t.balance_checkpoint_minor <> daily.balance_minor
  ) then
    raise exception 'The conversion changed a historical checkpoint balance';
  end if;

  if (select count(*)
      from public.transactions t
      join remaining_adjustment_candidates c on c.id = t.id
      where t.transaction_type = 'balance_adjustment'
        and t.adjustment_reason = c.adjustment_reason
        and t.balance_checkpoint_minor is not null
        and t.category_id is null
        and t.payee_id is null) <> 36 then
    raise exception 'Not all remaining adjustments were converted correctly';
  end if;
end
$$;

commit;
