begin;

create or replace function public.export_workspace_backup(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  table_name text;
  table_rows jsonb;
  table_data jsonb := '{}'::jsonb;
  workspace_data jsonb;
  backup_tables constant text[] := array[
    'accounts',
    'category_groups',
    'categories',
    'payees',
    'payee_mappings',
    'periods',
    'budgets',
    'fx_rates',
    'transactions',
    'bank_connections',
    'import_runs',
    'bank_account_aliases',
    'bank_transaction_refs',
    'bank_import_candidates'
  ];
begin
  if not public.is_workspace_member(p_workspace_id) then
    raise exception 'You do not have access to this workspace.';
  end if;

  select to_jsonb(workspace_row)
  into workspace_data
  from public.workspaces workspace_row
  where workspace_row.id = p_workspace_id;

  if workspace_data is null then
    raise exception 'The workspace no longer exists.';
  end if;

  foreach table_name in array backup_tables loop
    execute format(
      'select coalesce(jsonb_agg(to_jsonb(source_row)), ''[]''::jsonb) from public.%I source_row where workspace_id = $1',
      table_name
    )
    into table_rows
    using p_workspace_id;

    table_data := table_data || jsonb_build_object(table_name, table_rows);
  end loop;

  return jsonb_build_object(
    'format', 'next-expense-workspace-backup',
    'version', 1,
    'createdAt', now(),
    'workspace', workspace_data,
    'tables', table_data
  );
end;
$$;

create or replace function public.restore_workspace_backup(
  p_workspace_id uuid,
  p_backup jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  table_name text;
  table_rows jsonb;
  restored_rows jsonb;
  restored_counts jsonb := '{}'::jsonb;
  backup_tables constant text[] := array[
    'accounts',
    'category_groups',
    'categories',
    'payees',
    'payee_mappings',
    'periods',
    'budgets',
    'fx_rates',
    'transactions',
    'bank_connections',
    'import_runs',
    'bank_account_aliases',
    'bank_transaction_refs',
    'bank_import_candidates'
  ];
  insertion_order constant text[] := array[
    'accounts',
    'category_groups',
    'categories',
    'payees',
    'payee_mappings',
    'periods',
    'budgets',
    'fx_rates',
    'transactions',
    'bank_connections',
    'import_runs',
    'bank_account_aliases',
    'bank_transaction_refs',
    'bank_import_candidates'
  ];
begin
  if not exists (
    select 1
    from public.workspace_members member
    where member.workspace_id = p_workspace_id
      and member.user_id = auth.user_id()::text
      and member.role = 'owner'
  ) then
    raise exception 'Only the workspace owner can restore a backup.';
  end if;

  if jsonb_typeof(p_backup) <> 'object'
    or p_backup ->> 'format' <> 'next-expense-workspace-backup'
    or p_backup ->> 'version' <> '1'
    or jsonb_typeof(p_backup -> 'workspace') <> 'object'
    or jsonb_typeof(p_backup -> 'tables') <> 'object'
  then
    raise exception 'This is not a supported Next Expense backup.';
  end if;

  foreach table_name in array backup_tables loop
    if jsonb_typeof(p_backup #> array['tables', table_name]) <> 'array' then
      raise exception 'The backup is incomplete: % is missing.', table_name;
    end if;
  end loop;

  -- Delete dependants first. If anything below fails, PostgreSQL rolls the
  -- entire function call back, leaving the original workspace untouched.
  delete from public.bank_import_candidates where workspace_id = p_workspace_id;
  delete from public.bank_transaction_refs where workspace_id = p_workspace_id;
  delete from public.bank_account_aliases where workspace_id = p_workspace_id;
  delete from public.bank_connections where workspace_id = p_workspace_id;
  delete from public.import_runs where workspace_id = p_workspace_id;
  delete from public.transactions where workspace_id = p_workspace_id;
  delete from public.budgets where workspace_id = p_workspace_id;
  delete from public.fx_rates where workspace_id = p_workspace_id;
  delete from public.payee_mappings where workspace_id = p_workspace_id;
  delete from public.payees where workspace_id = p_workspace_id;
  delete from public.categories where workspace_id = p_workspace_id;
  delete from public.category_groups where workspace_id = p_workspace_id;
  delete from public.periods where workspace_id = p_workspace_id;
  delete from public.accounts where workspace_id = p_workspace_id;

  update public.workspaces
  set name = coalesce(nullif(btrim(p_backup #>> '{workspace,name}'), ''), name),
      default_currency = coalesce(nullif(btrim(p_backup #>> '{workspace,default_currency}'), ''), default_currency),
      import_timezone = coalesce(nullif(btrim(p_backup #>> '{workspace,import_timezone}'), ''), import_timezone),
      estimated_company_tax_rate_bps = coalesce((p_backup #>> '{workspace,estimated_company_tax_rate_bps}')::integer, estimated_company_tax_rate_bps)
  where id = p_workspace_id;

  foreach table_name in array insertion_order loop
    if table_name = 'transactions' then
      select coalesce(
        jsonb_agg(
          row_data
          || jsonb_build_object('workspace_id', p_workspace_id)
          || jsonb_build_object(
            'legacy_uncategorized',
            coalesce(
              (row_data ->> 'legacy_uncategorized')::boolean,
              row_data ->> 'category_id' is null
                and row_data ->> 'transaction_type' in ('expense', 'income')
                and row_data ->> 'source' = 'ios_import'
            )
          )
          || jsonb_build_object(
            'legacy_missing_payee',
            coalesce(
              (row_data ->> 'legacy_missing_payee')::boolean,
              row_data ->> 'payee_id' is null
                and row_data ->> 'transaction_type' in ('expense', 'income')
                and row_data ->> 'source' = 'ios_import'
            )
          )
        ),
        '[]'::jsonb
      )
      into restored_rows
      from jsonb_array_elements(p_backup #> array['tables', table_name]) row_data;
    else
      select coalesce(
        jsonb_agg(row_data || jsonb_build_object('workspace_id', p_workspace_id)),
        '[]'::jsonb
      )
      into restored_rows
      from jsonb_array_elements(p_backup #> array['tables', table_name]) row_data;
    end if;

    execute format(
      'insert into public.%I select * from jsonb_populate_recordset(null::public.%I, $1)',
      table_name,
      table_name
    )
    using restored_rows;

    restored_counts := restored_counts || jsonb_build_object(table_name, jsonb_array_length(restored_rows));
  end loop;

  return jsonb_build_object(
    'restoredAt', now(),
    'counts', restored_counts
  );
end;
$$;

revoke all on function public.export_workspace_backup(uuid) from public;
revoke all on function public.restore_workspace_backup(uuid, jsonb) from public;
grant execute on function public.export_workspace_backup(uuid) to authenticated;
grant execute on function public.restore_workspace_backup(uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';

commit;
