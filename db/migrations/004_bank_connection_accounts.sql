begin;

alter table public.bank_connections
  add column account_id uuid;

alter table public.bank_connections
  add constraint bank_connections_account_fk
  foreign key (workspace_id, account_id)
  references public.accounts(workspace_id, id)
  on delete cascade;

create unique index bank_connections_active_account_provider_idx
  on public.bank_connections(workspace_id, account_id, provider)
  where account_id is not null and status = 'active';

commit;
