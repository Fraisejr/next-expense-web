begin;

create function public.delete_unused_payee(
  p_workspace_id uuid,
  p_payee_id uuid
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.payees
    where workspace_id = p_workspace_id and id = p_payee_id
    for update
  ) then
    raise exception 'The payee no longer exists.';
  end if;

  if exists (
    select 1
    from public.transactions
    where workspace_id = p_workspace_id
      and (payee_id = p_payee_id or debtor_id = p_payee_id)
  ) then
    raise exception 'Only payees without transactions can be deleted.';
  end if;

  delete from public.payees
  where workspace_id = p_workspace_id and id = p_payee_id;
end;
$$;

revoke all on function public.delete_unused_payee(uuid, uuid) from public;
grant execute on function public.delete_unused_payee(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
