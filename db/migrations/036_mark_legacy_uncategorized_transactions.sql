begin;

alter table public.transactions
  add column legacy_uncategorized boolean not null default false;

alter table public.transactions
  drop constraint transactions_category_by_type_check;

update public.transactions
set legacy_uncategorized = true
where transaction_type in ('expense', 'income')
  and category_id is null
  and source = 'ios_import';

alter table public.transactions
  add constraint transactions_category_by_type_check check (
    (
      transaction_type in ('transfer', 'opening_balance', 'balance_adjustment')
      and category_id is null
      and legacy_uncategorized = false
    )
    or
    (
      transaction_type in ('expense', 'income')
      and (
        category_id is not null
        or (legacy_uncategorized = true and source = 'ios_import')
      )
    )
  ) not valid;

create or replace function public.normalize_legacy_uncategorized_transaction()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.category_id is not null or new.transaction_type not in ('expense', 'income') then
    new.legacy_uncategorized := false;
  end if;
  return new;
end;
$$;

create trigger transactions_normalize_legacy_uncategorized
before insert or update of category_id, transaction_type on public.transactions
for each row execute function public.normalize_legacy_uncategorized_transaction();

commit;
