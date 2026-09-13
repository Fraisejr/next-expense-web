begin;

-- Rejection reasons distinguish automatic exclusions from user decisions.
alter table public.bank_import_candidates add column decision_reason text;

-- Existing zero-value review entries retain their IDs and full raw payload.
update public.bank_import_candidates
set status = 'rejected', decision_reason = 'zero_amount', decided_at = now()
where status = 'pending' and amount_minor = 0
  and provider = 'gocardless_bank_account_data';

notify pgrst, 'reload schema';
commit;

-- Deployment step: refresh the schema cache from Neon Data API controls.
-- NOTIFY alone may not refresh the managed Data API; verify before deploying.
