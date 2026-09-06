begin;

create index if not exists transactions_workspace_category_date_idx
  on public.transactions(workspace_id, category_id, transaction_date desc);

create index if not exists transactions_workspace_payee_date_idx
  on public.transactions(workspace_id, payee_id, transaction_date desc);

create index if not exists transactions_workspace_destination_date_idx
  on public.transactions(workspace_id, destination_account_id, transaction_date desc)
  where destination_account_id is not null;

create or replace function public.effective_balance_adjustment_amount(
  p_workspace_id uuid,
  p_account_id uuid,
  p_transaction_date date,
  p_checkpoint_minor bigint
)
returns bigint
language sql
stable
security invoker
set search_path = ''
as $$
  with previous_adjustment as (
    select adjustment.transaction_date, adjustment.balance_checkpoint_minor
    from public.transactions adjustment
    where adjustment.workspace_id = p_workspace_id
      and adjustment.account_id = p_account_id
      and adjustment.transaction_type = 'balance_adjustment'
      and adjustment.transaction_date < p_transaction_date
    order by adjustment.transaction_date desc
    limit 1
  ), ledger_events as (
    select ledger_transaction.transaction_date,
      case ledger_transaction.transaction_type
        when 'income' then ledger_transaction.amount_minor
        when 'expense' then -ledger_transaction.amount_minor
        when 'opening_balance' then ledger_transaction.amount_minor
        when 'transfer' then -ledger_transaction.amount_minor
        else 0
      end::bigint as delta_minor
    from public.transactions ledger_transaction
    where ledger_transaction.workspace_id = p_workspace_id
      and ledger_transaction.account_id = p_account_id
      and ledger_transaction.transaction_type <> 'balance_adjustment'
    union all
    select ledger_transaction.transaction_date,
      coalesce(nullif(ledger_transaction.destination_amount_minor, 0), ledger_transaction.amount_minor)::bigint
    from public.transactions ledger_transaction
    where ledger_transaction.workspace_id = p_workspace_id
      and ledger_transaction.destination_account_id = p_account_id
      and ledger_transaction.transaction_type = 'transfer'
  )
  select p_checkpoint_minor - (
    coalesce((select balance_checkpoint_minor from previous_adjustment), 0)
    + coalesce((
      select sum(event.delta_minor)
      from ledger_events event
      where event.transaction_date <= p_transaction_date
        and (
          not exists (select 1 from previous_adjustment)
          or event.transaction_date > (select transaction_date from previous_adjustment)
        )
    ), 0)
  );
$$;

create or replace function public.workspace_account_balances(p_workspace_id uuid)
returns table(account_id uuid, balance_minor bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  with latest_adjustments as (
    select distinct on (adjustment.account_id)
      adjustment.account_id,
      adjustment.transaction_date,
      adjustment.balance_checkpoint_minor
    from public.transactions adjustment
    where adjustment.workspace_id = p_workspace_id
      and adjustment.transaction_type = 'balance_adjustment'
    order by adjustment.account_id, adjustment.transaction_date desc
  ), ledger_events as (
    select ledger_transaction.account_id,
      ledger_transaction.transaction_date,
      case ledger_transaction.transaction_type
        when 'income' then ledger_transaction.amount_minor
        when 'expense' then -ledger_transaction.amount_minor
        when 'opening_balance' then ledger_transaction.amount_minor
        when 'transfer' then -ledger_transaction.amount_minor
        else 0
      end::bigint as delta_minor
    from public.transactions ledger_transaction
    where ledger_transaction.workspace_id = p_workspace_id
      and ledger_transaction.account_id is not null
      and ledger_transaction.transaction_type <> 'balance_adjustment'
    union all
    select ledger_transaction.destination_account_id,
      ledger_transaction.transaction_date,
      coalesce(nullif(ledger_transaction.destination_amount_minor, 0), ledger_transaction.amount_minor)::bigint
    from public.transactions ledger_transaction
    where ledger_transaction.workspace_id = p_workspace_id
      and ledger_transaction.destination_account_id is not null
      and ledger_transaction.transaction_type = 'transfer'
  )
  select account.id,
    (
      coalesce(adjustment.balance_checkpoint_minor, 0)
      + coalesce(sum(event.delta_minor) filter (
        where adjustment.account_id is null
          or event.transaction_date > adjustment.transaction_date
      ), 0)
    )::bigint as balance_minor
  from public.accounts account
  left join latest_adjustments adjustment on adjustment.account_id = account.id
  left join ledger_events event on event.account_id = account.id
  where account.workspace_id = p_workspace_id
  group by account.id, adjustment.account_id, adjustment.balance_checkpoint_minor, adjustment.transaction_date
  order by account.id;
$$;

create or replace function public.list_workspace_transactions(
  p_workspace_id uuid,
  p_limit integer default 1000,
  p_offset integer default 0,
  p_search text default null,
  p_account_id uuid default null,
  p_category_id uuid default null,
  p_payee_id uuid default null,
  p_uncategorized boolean default false,
  p_start_date date default null,
  p_end_date date default null
)
returns table(
  id uuid,
  transaction_date date,
  payee text,
  payee_id uuid,
  debtor_id uuid,
  memo text,
  amount_minor bigint,
  destination_amount_minor bigint,
  transaction_type text,
  account_id uuid,
  category_id uuid,
  destination_account_id uuid,
  currency text,
  payee_name text,
  source text,
  provider_transaction_id text,
  posted boolean,
  balance_checkpoint_minor bigint,
  adjustment_reason text,
  total_count bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with filtered as (
    select ledger_transaction.*,
      case
        when ledger_transaction.transaction_type = 'opening_balance' then 'Opening balance'
        when ledger_transaction.transaction_type = 'balance_adjustment' then 'Balance adjustment'
        else coalesce(resolved_payee.name, ledger_transaction.payee_name, ledger_transaction.memo, 'Unknown payee')
      end as display_payee
    from public.transactions ledger_transaction
    left join public.payees resolved_payee on resolved_payee.id = ledger_transaction.payee_id
    left join public.categories category on category.id = ledger_transaction.category_id
    left join public.accounts source_account on source_account.id = ledger_transaction.account_id
    left join public.accounts destination_account on destination_account.id = ledger_transaction.destination_account_id
    where ledger_transaction.workspace_id = p_workspace_id
      and (p_account_id is null or ledger_transaction.account_id = p_account_id or ledger_transaction.destination_account_id = p_account_id)
      and (p_category_id is null or ledger_transaction.category_id = p_category_id)
      and (p_payee_id is null or ledger_transaction.payee_id = p_payee_id)
      and (not p_uncategorized or (ledger_transaction.transaction_type in ('expense', 'income') and ledger_transaction.category_id is null))
      and (p_start_date is null or ledger_transaction.transaction_date >= p_start_date)
      and (p_end_date is null or ledger_transaction.transaction_date < p_end_date)
      and (
        nullif(trim(p_search), '') is null
        or concat_ws(' ', resolved_payee.name, ledger_transaction.payee_name, ledger_transaction.memo,
          category.name, source_account.name, destination_account.name, ledger_transaction.transaction_date::text)
          ilike '%' || trim(p_search) || '%'
      )
  )
  select filtered.id,
    filtered.transaction_date,
    filtered.display_payee,
    filtered.payee_id,
    filtered.debtor_id,
    filtered.memo,
    case when filtered.transaction_type = 'balance_adjustment'
      then public.effective_balance_adjustment_amount(filtered.workspace_id, filtered.account_id, filtered.transaction_date, filtered.balance_checkpoint_minor)
      else filtered.amount_minor
    end as amount_minor,
    filtered.destination_amount_minor,
    filtered.transaction_type,
    filtered.account_id,
    filtered.category_id,
    filtered.destination_account_id,
    filtered.currency,
    filtered.payee_name,
    filtered.source,
    filtered.provider_transaction_id,
    filtered.posted,
    filtered.balance_checkpoint_minor,
    filtered.adjustment_reason,
    count(*) over () as total_count
  from filtered
  order by filtered.transaction_date desc,
    (filtered.transaction_type = 'balance_adjustment') desc,
    filtered.id
  limit greatest(1, least(p_limit, 1000))
  offset greatest(0, p_offset);
$$;

revoke all on function public.effective_balance_adjustment_amount(uuid, uuid, date, bigint) from public;
revoke all on function public.workspace_account_balances(uuid) from public;
revoke all on function public.list_workspace_transactions(uuid, integer, integer, text, uuid, uuid, uuid, boolean, date, date) from public;
grant execute on function public.effective_balance_adjustment_amount(uuid, uuid, date, bigint) to authenticated;
grant execute on function public.workspace_account_balances(uuid) to authenticated;
grant execute on function public.list_workspace_transactions(uuid, integer, integer, text, uuid, uuid, uuid, boolean, date, date) to authenticated;

notify pgrst, 'reload schema';

commit;
