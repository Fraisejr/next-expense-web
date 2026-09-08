begin;

alter table public.time_entries
  add constraint time_entries_whole_hours_check
  check (hours = trunc(hours));

notify pgrst, 'reload schema';

commit;
