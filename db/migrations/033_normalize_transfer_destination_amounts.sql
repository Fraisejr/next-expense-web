begin;

-- Legacy same-currency transfers used zero as shorthand for "same as the
-- source amount". Store that amount explicitly so every balance calculation
-- has one unambiguous representation.
create temporary table zero_destination_transfers on commit drop as
select t.id, t.amount_minor
from public.transactions t
join public.accounts source_account on source_account.id = t.account_id
join public.accounts destination_account on destination_account.id = t.destination_account_id
where t.transaction_type = 'transfer'
  and t.destination_amount_minor = 0
  and source_account.currency = destination_account.currency
  and t.amount_minor <> 0;

do $$
begin
  if (select count(*) from zero_destination_transfers) <> 306 then
    raise exception 'Expected 306 same-currency transfers to normalize, found %',
      (select count(*) from zero_destination_transfers);
  end if;

  if exists (
    select 1
    from public.transactions t
    join public.accounts source_account on source_account.id = t.account_id
    join public.accounts destination_account on destination_account.id = t.destination_account_id
    where t.transaction_type = 'transfer'
      and t.destination_amount_minor = 0
      and (
        source_account.currency <> destination_account.currency
        or t.amount_minor = 0
      )
  ) then
    raise exception 'A zero-destination transfer cannot be normalized safely';
  end if;
end
$$;

update public.transactions t
set
  destination_amount_minor = candidate.amount_minor,
  updated_at = now()
from zero_destination_transfers candidate
where t.id = candidate.id;

do $$
begin
  if exists (
    select 1
    from public.transactions t
    join zero_destination_transfers candidate on candidate.id = t.id
    where t.destination_amount_minor <> t.amount_minor
  ) then
    raise exception 'A normalized destination amount does not match its source amount';
  end if;

  if exists (
    select 1
    from public.transactions
    where transaction_type = 'transfer'
      and destination_amount_minor = 0
  ) then
    raise exception 'A zero destination amount remains after normalization';
  end if;
end
$$;

commit;
