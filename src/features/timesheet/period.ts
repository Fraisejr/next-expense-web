import { earnedWorkMonthRange } from '../../revenue'

export function formatEarnedTimesheetPeriod(today: string, year: number) {
  const range = earnedWorkMonthRange(today, year)
  if (!range) return 'No timesheets earned yet'
  const formatter = new Intl.DateTimeFormat('en', { month: 'short', year: '2-digit', timeZone: 'UTC' })
  const formatMonth = (month: string) => formatter.format(new Date(`${month}-01T00:00:00Z`))
  return `${formatMonth(range.startMonth)}–${formatMonth(range.endMonth)} timesheets`
}
