begin;

alter table public.payee_mappings
  drop constraint payee_mappings_pkey,
  add column id uuid;

alter table public.payee_mappings
  alter column id set not null,
  add primary key (id),
  add unique (workspace_id, source_name, payee_id);

create index payee_mappings_workspace_normalized_idx
  on public.payee_mappings(workspace_id, normalized_name);

commit;
