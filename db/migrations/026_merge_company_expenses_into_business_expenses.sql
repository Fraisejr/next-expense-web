begin;

do $$
declare
  source_workspace_id uuid;
  target_workspace_id uuid;
begin
  select workspace_id into source_workspace_id
  from public.categories
  where id = 'e303513a-3a5d-488c-a4e5-7037039e16a1'
    and name = 'Company expenses';

  select workspace_id into target_workspace_id
  from public.categories
  where id = 'b3abd47f-b019-4e0a-8446-447c7e8be79f'
    and name = 'Business expenses'
    and hidden = false;

  if source_workspace_id is null then
    raise exception 'The Company expenses source category was not found';
  end if;

  if target_workspace_id is null then
    raise exception 'The active Business expenses target category was not found';
  end if;

  if source_workspace_id <> target_workspace_id then
    raise exception 'The source and target categories belong to different workspaces';
  end if;
end $$;

update public.transactions
set category_id = 'b3abd47f-b019-4e0a-8446-447c7e8be79f',
    updated_at = now()
where category_id = 'e303513a-3a5d-488c-a4e5-7037039e16a1';

update public.payees
set default_category_id = 'b3abd47f-b019-4e0a-8446-447c7e8be79f',
    updated_at = now()
where default_category_id = 'e303513a-3a5d-488c-a4e5-7037039e16a1';

update public.bank_import_candidates
set category_id = 'b3abd47f-b019-4e0a-8446-447c7e8be79f',
    updated_at = now()
where category_id = 'e303513a-3a5d-488c-a4e5-7037039e16a1';

update public.budgets
set category_id = 'b3abd47f-b019-4e0a-8446-447c7e8be79f',
    updated_at = now()
where category_id = 'e303513a-3a5d-488c-a4e5-7037039e16a1';

do $$
begin
  if exists (
    select 1 from public.transactions where category_id = 'e303513a-3a5d-488c-a4e5-7037039e16a1'
    union all
    select 1 from public.payees where default_category_id = 'e303513a-3a5d-488c-a4e5-7037039e16a1'
    union all
    select 1 from public.bank_import_candidates where category_id = 'e303513a-3a5d-488c-a4e5-7037039e16a1'
    union all
    select 1 from public.budgets where category_id = 'e303513a-3a5d-488c-a4e5-7037039e16a1'
  ) then
    raise exception 'Some references still point to Company expenses';
  end if;
end $$;

commit;
