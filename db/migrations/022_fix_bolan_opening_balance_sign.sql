begin;

update public.transactions transaction
set amount_minor = -281300000,
    updated_at = now()
from public.accounts account
where transaction.id = '1214f2f0-dc60-4893-827f-bd25b9e32082'
  and transaction.account_id = account.id
  and account.name = 'Bolån'
  and transaction.transaction_type = 'opening_balance'
  and transaction.amount_minor = 281300000;

do $$
begin
  if not exists (
    select 1
    from public.transactions transaction
    join public.accounts account on account.id = transaction.account_id
    where transaction.id = '1214f2f0-dc60-4893-827f-bd25b9e32082'
      and account.name = 'Bolån'
      and transaction.transaction_type = 'opening_balance'
      and transaction.amount_minor = -281300000
  ) then
    raise exception 'Bolån opening balance was not corrected to a negative liability';
  end if;
end $$;

commit;
