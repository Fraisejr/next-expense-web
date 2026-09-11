begin;

create or replace function public.save_time_code_order(
  p_workspace_id uuid,
  p_time_code_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_workspace_member(p_workspace_id) then
    raise exception 'You do not have access to this workspace.' using errcode = '42501';
  end if;

  if cardinality(p_time_code_ids) <> (
    select count(*) from public.time_codes where workspace_id = p_workspace_id
  ) or cardinality(p_time_code_ids) <> (
    select count(distinct code_id) from unnest(p_time_code_ids) code_id
  ) or exists (
    select 1
    from unnest(p_time_code_ids) code_id
    where not exists (
      select 1 from public.time_codes code
      where code.workspace_id = p_workspace_id and code.id = code_id
    )
  ) then
    raise exception 'The time code order is incomplete.' using errcode = '22023';
  end if;

  update public.time_codes code
  set sort_order = ordered.position - 1
  from unnest(p_time_code_ids) with ordinality as ordered(code_id, position)
  where code.workspace_id = p_workspace_id
    and code.id = ordered.code_id;
end;
$$;

revoke all on function public.save_time_code_order(uuid, uuid[]) from public;
grant execute on function public.save_time_code_order(uuid, uuid[]) to authenticated;

notify pgrst, 'reload schema';

commit;
