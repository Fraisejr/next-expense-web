begin;

update public.transactions t
set adjustment_reason = 'asset_valuation'
from public.accounts account
where t.account_id = account.id
  and t.workspace_id = account.workspace_id
  and t.transaction_type = 'balance_adjustment'
  and t.adjustment_reason = 'market_valuation'
  and account.name ~* '(tesla|car|vehicle|auto|voiture|coche)';

commit;
