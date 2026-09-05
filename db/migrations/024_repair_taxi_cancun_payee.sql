begin;

do $$
begin
  if not exists (
    select 1 from public.payees
    where id = '228a4458-9e15-4f5f-b244-2b0e50db6a1c'
      and name = 'Taxi Cancun'
  ) then
    raise exception 'The retained Taxi Cancun payee was not found';
  end if;

  if not exists (
    select 1 from public.transactions
    where id = '69ff8a26-c326-4e2a-823c-15f493416c36'
      and payee_id is null
      and lower(btrim(coalesce(nullif(payee_name, ''), nullif(memo, ''), 'Unknown payee'))) = 'taxi cancun'
  ) then
    raise exception 'The unmatched Taxi Cancun transaction was not found';
  end if;
end $$;

insert into public.payee_mappings
  (id, workspace_id, normalized_name, source_name, payee_id)
select
  pg_catalog.gen_random_uuid(),
  payee.workspace_id,
  'taxi cancun',
  'Taxi Cancun',
  payee.id
from public.payees payee
where payee.id = '228a4458-9e15-4f5f-b244-2b0e50db6a1c'
on conflict (workspace_id, source_name, payee_id) do nothing;

update public.transactions
set payee_id = '228a4458-9e15-4f5f-b244-2b0e50db6a1c',
    updated_at = now()
where id = '69ff8a26-c326-4e2a-823c-15f493416c36'
  and payee_id is null;

delete from public.payees payee
where payee.id = '4f08f338-c5d2-4681-ac36-eb17d7c35116'
  and payee.name = 'Taxi Cancun'
  and not exists (select 1 from public.transactions transaction where transaction.payee_id = payee.id)
  and not exists (select 1 from public.payee_mappings mapping where mapping.payee_id = payee.id);

do $$
begin
  if (select count(*) from public.payees where name = 'Taxi Cancun') <> 1 then
    raise exception 'Taxi Cancun duplicate cleanup did not leave exactly one payee';
  end if;
  if not exists (
    select 1 from public.transactions
    where id = '69ff8a26-c326-4e2a-823c-15f493416c36'
      and payee_id = '228a4458-9e15-4f5f-b244-2b0e50db6a1c'
  ) then
    raise exception 'Taxi Cancun transaction was not linked';
  end if;
end $$;

commit;
