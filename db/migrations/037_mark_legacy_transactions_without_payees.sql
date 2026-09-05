begin;

alter table public.transactions
  add column legacy_missing_payee boolean not null default false;

alter table public.transactions
  drop constraint transactions_payee_by_type_check;

update public.transactions
set legacy_missing_payee = true
where transaction_type in ('expense', 'income')
  and payee_id is null
  and source = 'ios_import';

alter table public.transactions
  add constraint transactions_payee_by_type_check check (
    transaction_type in ('transfer', 'opening_balance', 'balance_adjustment')
    or payee_id is not null
    or (legacy_missing_payee = true and source = 'ios_import')
  ) not valid;

create or replace function public.normalize_legacy_missing_payee_transaction()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.payee_id is not null or new.transaction_type not in ('expense', 'income') then
    new.legacy_missing_payee := false;
  end if;
  return new;
end;
$$;

create trigger transactions_normalize_legacy_missing_payee
before insert or update of payee_id, transaction_type on public.transactions
for each row execute function public.normalize_legacy_missing_payee_transaction();

commit;
