begin;

-- Migrations 030 and 031 initially calculated imported checkpoints using the
-- stored destination amount directly. Legacy same-currency transfers commonly
-- store zero there, while the application correctly falls back to amount_minor.
-- Add that omitted cumulative transfer value to each imported checkpoint.
create temporary table checkpoint_repairs on commit drop as
select
  adjustment.id,
  coalesce(sum(incoming.amount_minor), 0)::bigint as omitted_transfer_minor
from public.transactions adjustment
left join public.transactions incoming
  on incoming.transaction_type = 'transfer'
 and incoming.destination_account_id = adjustment.account_id
 and incoming.destination_amount_minor = 0
 and incoming.transaction_date <= adjustment.transaction_date
where adjustment.transaction_type = 'balance_adjustment'
  and adjustment.source = 'ios_import'
group by adjustment.id;

do $$
begin
  if (select count(*) from checkpoint_repairs) <> 125 then
    raise exception 'Expected 125 imported checkpoints to repair, found %',
      (select count(*) from checkpoint_repairs);
  end if;
end
$$;

update public.transactions adjustment
set
  balance_checkpoint_minor = adjustment.balance_checkpoint_minor + repair.omitted_transfer_minor,
  updated_at = now()
from checkpoint_repairs repair
where adjustment.id = repair.id
  and repair.omitted_transfer_minor <> 0;

do $$
begin
  if (select count(*) from public.transactions
      where transaction_type = 'balance_adjustment'
        and source = 'ios_import'
        and balance_checkpoint_minor is null) <> 0 then
    raise exception 'A repaired checkpoint is missing its observed balance';
  end if;
end
$$;

commit;
