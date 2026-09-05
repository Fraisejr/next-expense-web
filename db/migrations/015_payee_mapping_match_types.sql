begin;

alter table public.payee_mappings
  add column match_type text not null default 'exact'
  check (match_type in ('exact', 'starts_with'));

comment on column public.payee_mappings.match_type is
  'exact matches the full normalized bank description; starts_with requires the next character to be a non-alphanumeric separator.';

commit;
