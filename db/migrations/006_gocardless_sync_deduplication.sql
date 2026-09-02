begin;

-- Imported iOS data contains a handful of repeated provider IDs. Limit the
-- database-level guard to new GoCardless sync rows while the application also
-- checks the historical provider IDs before importing.
create unique index transactions_gocardless_provider_unique_idx
  on public.transactions(workspace_id, account_id, provider_transaction_id)
  where source = 'gocardless'
    and provider_transaction_id is not null
    and provider_transaction_id <> '';

commit;
