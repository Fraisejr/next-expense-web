begin;

-- Link historical transactions only when there is an explicit alias mapping or
-- an exact canonical-name match. Unknown bank descriptions intentionally remain
-- unlinked so the user can review them instead of polluting the payee register.
with resolved_transactions as (
  select
    transaction.id,
    transaction.workspace_id,
    coalesce(
      (
        select mapping.payee_id
        from public.payee_mappings mapping
        where mapping.workspace_id = transaction.workspace_id
          and mapping.normalized_name = lower(btrim(transaction.payee_name))
        order by mapping.created_at, mapping.id
        limit 1
      ),
      (
        select payee.id
        from public.payees payee
        where payee.workspace_id = transaction.workspace_id
          and lower(btrim(payee.name)) = lower(btrim(transaction.payee_name))
        order by payee.created_at, payee.id
        limit 1
      )
    ) as payee_id
  from public.transactions transaction
  where transaction.payee_id is null
    and transaction.transaction_type <> 'transfer'
    and transaction.payee_name is not null
    and length(btrim(transaction.payee_name)) > 0
)
update public.transactions transaction
set payee_id = resolved.payee_id
from resolved_transactions resolved
where transaction.workspace_id = resolved.workspace_id
  and transaction.id = resolved.id
  and resolved.payee_id is not null;

-- Remember every raw spelling as an alias so future imports resolve to the same
-- register entry while retaining the original payee_name on the transaction.
insert into public.payee_mappings (id, workspace_id, normalized_name, source_name, payee_id)
select
  gen_random_uuid(),
  source.workspace_id,
  source.normalized_name,
  source.source_name,
  source.payee_id
from (
  select distinct
    transaction.workspace_id,
    lower(btrim(transaction.payee_name)) as normalized_name,
    btrim(transaction.payee_name) as source_name,
    transaction.payee_id
  from public.transactions transaction
  where transaction.payee_id is not null
    and transaction.transaction_type <> 'transfer'
    and transaction.payee_name is not null
    and length(btrim(transaction.payee_name)) > 0
) source
where not exists (
    select 1
    from public.payee_mappings mapping
    where mapping.workspace_id = source.workspace_id
      and mapping.source_name = source.source_name
      and mapping.payee_id = source.payee_id
  );

commit;
