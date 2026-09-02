begin;

alter table public.transactions
  add column bank_transaction_id text;

create index transactions_bank_transaction_idx
  on public.transactions(workspace_id, account_id, bank_transaction_id)
  where bank_transaction_id is not null and bank_transaction_id <> '';

-- One transaction was synced before both identifiers were retained. Its
-- provider field currently contains the bank-supplied ID; preserve that value
-- in the dedicated column. The next sync will replace the provider field with
-- GoCardless's internal ID through the exact fingerprint repair.
update public.transactions
set bank_transaction_id = provider_transaction_id
where source = 'gocardless'
  and provider_transaction_id is not null
  and bank_transaction_id is null;

commit;
