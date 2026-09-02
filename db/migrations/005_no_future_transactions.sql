begin;

delete from public.transactions
where transaction_date > (now() at time zone 'Europe/Paris')::date;

create or replace function public.reject_future_transaction()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.transaction_date > (now() at time zone 'Europe/Paris')::date then
    raise exception 'Future-dated transactions are not supported';
  end if;
  return new;
end;
$$;

drop trigger if exists transactions_reject_future_date on public.transactions;
create trigger transactions_reject_future_date
  before insert or update of transaction_date on public.transactions
  for each row execute function public.reject_future_transaction();

commit;
