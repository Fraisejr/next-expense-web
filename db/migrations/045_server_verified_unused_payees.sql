begin;

create function public.list_unused_payee_ids(
  p_workspace_id uuid
)
returns table(payee_id uuid)
language sql
stable
security invoker
set search_path = ''
as $$
  select payee.id
  from public.payees payee
  where payee.workspace_id = p_workspace_id
    and not exists (
      select 1
      from public.transactions ledger_transaction
      where ledger_transaction.workspace_id = p_workspace_id
        and (ledger_transaction.payee_id = payee.id or ledger_transaction.debtor_id = payee.id)
    )
  order by payee.name, payee.id;
$$;

create function public.delete_all_unused_payees(
  p_workspace_id uuid
)
returns table(payee_id uuid)
language sql
security invoker
set search_path = ''
as $$
  delete from public.payees payee
  where payee.workspace_id = p_workspace_id
    and not exists (
      select 1
      from public.transactions ledger_transaction
      where ledger_transaction.workspace_id = p_workspace_id
        and (ledger_transaction.payee_id = payee.id or ledger_transaction.debtor_id = payee.id)
    )
  returning payee.id;
$$;

revoke all on function public.list_unused_payee_ids(uuid) from public;
revoke all on function public.delete_all_unused_payees(uuid) from public;
grant execute on function public.list_unused_payee_ids(uuid) to authenticated;
grant execute on function public.delete_all_unused_payees(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
