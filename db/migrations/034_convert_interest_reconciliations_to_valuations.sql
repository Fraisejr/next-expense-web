begin;

-- For this workspace, interest credited to long-term savings accounts is
-- treated like the rest of the investment return: as a market-value checkpoint
-- outside the operating P&L.
create temporary table interest_valuation_candidates on commit drop as
select t.id, t.account_id, t.transaction_date
from public.transactions t
join public.accounts a on a.id = t.account_id
where a.name in ('Avanza Collector', 'LDD', 'Livret A')
  and t.transaction_type = 'income'
  and lower(coalesce(t.memo, '')) like '%reconcil%';

do $$
begin
  if (select count(*) from interest_valuation_candidates) <> 8 then
    raise exception 'Expected 8 savings-interest valuations, found %',
      (select count(*) from interest_valuation_candidates);
  end if;

  if exists (
    select 1
    from public.transactions adjustment
    join interest_valuation_candidates candidate
      on candidate.account_id = adjustment.account_id
    where adjustment.transaction_type = 'balance_adjustment'
  ) then
    raise exception 'An affected savings account already has a balance adjustment';
  end if;
end
$$;

create temporary table affected_accounts on commit drop as
select distinct account_id from interest_valuation_candidates;

create temporary table daily_balances_before on commit drop as
with daily_changes as (
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
      t.destination_account_id,
      t.transaction_date,
      t.destination_amount_minor
    from public.transactions t
    join affected_accounts a on a.account_id = t.destination_account_id
    where t.transaction_type = 'transfer'
  ) events
  group by account_id, transaction_date
)
select
  account_id,
  transaction_date,
  sum(delta_minor) over (
    partition by account_id
    order by transaction_date
    rows between unbounded preceding and current row
  )::bigint as balance_minor
from daily_changes;

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
  adjustment_reason = 'market_valuation',
  source_timestamp = (t.transaction_date::text || ' 23:59:59+00')::timestamptz,
  updated_at = now()
from interest_valuation_candidates candidate
join daily_balances_before daily
  on daily.account_id = candidate.account_id
 and daily.transaction_date = candidate.transaction_date
where t.id = candidate.id;

create temporary table balances_after on commit drop as
with latest_adjustments as (
  select distinct on (t.account_id)
    t.account_id,
    t.transaction_date,
    t.balance_checkpoint_minor
  from public.transactions t
  join affected_accounts a on a.account_id = t.account_id
  where t.transaction_type = 'balance_adjustment'
  order by t.account_id, t.transaction_date desc, t.id desc
), later_effects as (
  select account_id, sum(delta_minor)::bigint as delta_minor
  from (
    select
      t.account_id,
      case t.transaction_type
        when 'income' then t.amount_minor
        when 'expense' then -t.amount_minor
        when 'opening_balance' then t.amount_minor
        when 'transfer' then -t.amount_minor
        else 0
      end as delta_minor
    from public.transactions t
    join latest_adjustments latest on latest.account_id = t.account_id
    where t.transaction_date > latest.transaction_date

    union all

    select t.destination_account_id, t.destination_amount_minor
    from public.transactions t
    join latest_adjustments latest on latest.account_id = t.destination_account_id
    where t.transaction_type = 'transfer'
      and t.transaction_date > latest.transaction_date
  ) events
  group by account_id
)
select
  latest.account_id,
  (latest.balance_checkpoint_minor + coalesce(later.delta_minor, 0))::bigint as balance_minor
from latest_adjustments latest
left join later_effects later using (account_id);

do $$
begin
  if exists (
    select 1
    from balances_before before_balance
    join balances_after after_balance using (account_id)
    where before_balance.balance_minor <> after_balance.balance_minor
  ) then
    raise exception 'The interest conversion changed a current account balance';
  end if;

  if (select count(*)
      from public.transactions t
      join interest_valuation_candidates c on c.id = t.id
      where t.transaction_type = 'balance_adjustment'
        and t.adjustment_reason = 'market_valuation'
        and t.balance_checkpoint_minor is not null
        and t.category_id is null
        and t.payee_id is null) <> 8 then
    raise exception 'Not all interest valuations were converted correctly';
  end if;
end
$$;

commit;
