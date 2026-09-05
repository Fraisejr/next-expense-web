begin;

create function public.delete_unused_category(
  p_workspace_id uuid,
  p_category_id uuid
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.categories
    where workspace_id = p_workspace_id and id = p_category_id
    for update
  ) then
    raise exception 'The category no longer exists.';
  end if;

  if exists (
    select 1 from public.transactions
    where workspace_id = p_workspace_id and category_id = p_category_id
  ) then
    raise exception 'Only categories without transactions can be deleted.';
  end if;

  update public.payees
  set default_category_id = null
  where workspace_id = p_workspace_id and default_category_id = p_category_id;

  update public.bank_import_candidates
  set category_id = null
  where workspace_id = p_workspace_id and category_id = p_category_id;

  delete from public.budgets
  where workspace_id = p_workspace_id and category_id = p_category_id;

  delete from public.categories
  where workspace_id = p_workspace_id and id = p_category_id;
end;
$$;

revoke all on function public.delete_unused_category(uuid, uuid) from public;
grant execute on function public.delete_unused_category(uuid, uuid) to authenticated;

commit;

notify pgrst, 'reload schema';
