begin;

create or replace function public.assign_payee_mapping(
  p_workspace_id uuid,
  p_source_name text,
  p_payee_id uuid
)
returns uuid[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  linked_transaction_ids uuid[];
begin
  if not public.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access denied' using errcode = '42501';
  end if;

  if length(btrim(p_source_name)) = 0 then
    raise exception 'A bank description is required' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.payees payee
    where payee.workspace_id = p_workspace_id
      and payee.id = p_payee_id
  ) then
    raise exception 'Payee not found' using errcode = '22023';
  end if;

  insert into public.payee_mappings (
    id,
    workspace_id,
    normalized_name,
    source_name,
    payee_id
  ) values (
    pg_catalog.gen_random_uuid(),
    p_workspace_id,
    lower(btrim(p_source_name)),
    btrim(p_source_name),
    p_payee_id
  )
  on conflict (workspace_id, source_name, payee_id) do nothing;

  with linked as (
    update public.transactions transaction
    set payee_id = p_payee_id
    where transaction.workspace_id = p_workspace_id
      and transaction.payee_id is null
      and transaction.transaction_type in ('expense', 'income')
      and lower(btrim(coalesce(
        nullif(btrim(transaction.payee_name), ''),
        nullif(btrim(transaction.memo), ''),
        'Unknown payee'
      ))) = lower(btrim(p_source_name))
    returning transaction.id
  )
  select coalesce(array_agg(linked.id), array[]::uuid[])
  into linked_transaction_ids
  from linked;

  if cardinality(linked_transaction_ids) = 0 then
    raise exception 'No unmatched transactions matched this description' using errcode = 'P0002';
  end if;

  return linked_transaction_ids;
end;
$$;

revoke all on function public.assign_payee_mapping(uuid, text, uuid) from public;
grant execute on function public.assign_payee_mapping(uuid, text, uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
