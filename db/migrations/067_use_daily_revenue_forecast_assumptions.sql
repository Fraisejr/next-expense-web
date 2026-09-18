begin;

alter table public.timesheet_client_forecasts
  drop constraint timesheet_client_forecasts_weekly_hours_check,
  drop constraint timesheet_client_forecasts_vacation_weeks_check;

alter table public.timesheet_client_forecasts
  rename column weekly_hours to hours_per_day;

alter table public.timesheet_client_forecasts
  rename column vacation_weeks to vacation_days_remaining;

update public.timesheet_client_forecasts
set hours_per_day = hours_per_day / 5,
    vacation_days_remaining = vacation_days_remaining * 5;

alter table public.timesheet_client_forecasts
  alter column hours_per_day type numeric(5, 2),
  alter column vacation_days_remaining type numeric(6, 2),
  add constraint timesheet_client_forecasts_hours_per_day_check
    check (hours_per_day >= 0 and hours_per_day <= 24),
  add constraint timesheet_client_forecasts_vacation_days_remaining_check
    check (vacation_days_remaining >= 0 and vacation_days_remaining <= 366);

notify pgrst, 'reload schema';

commit;
