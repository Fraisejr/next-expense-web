import { neon } from '../../neon'
import type { TimeCode, TimeComment, TimeEntry, TimesheetClient, TimesheetClientForecast, TimesheetClientRate } from '../../types'

type Row = Record<string, unknown>
const number = (value: unknown) => Number(value ?? 0)

export async function loadTimeEntries(workspaceId: string, month: string): Promise<TimeEntry[]> {
  const startDate = `${month}-01`
  const nextMonth = new Date(`${startDate}T12:00:00Z`)
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1)
  const { data, error } = await neon.from('time_entries')
    .select('time_code_id,work_date,hours')
    .eq('workspace_id', workspaceId)
    .gte('work_date', startDate)
    .lt('work_date', nextMonth.toISOString().slice(0, 10))
    .order('work_date', { ascending: true })
  if (error) throw error
  return ((data ?? []) as unknown as Row[]).map((row) => ({
    codeId: String(row.time_code_id),
    date: String(row.work_date),
    hours: number(row.hours),
  }))
}

export async function loadRevenueRecognitionEntries(workspaceId: string, year: number): Promise<TimeEntry[]> {
  const startDate = `${year - 1}-12-01`
  const endDate = `${year}-12-01`
  const { data, error } = await neon.from('time_entries')
    .select('time_code_id,work_date,hours')
    .eq('workspace_id', workspaceId)
    .gte('work_date', startDate)
    .lt('work_date', endDate)
    .order('work_date', { ascending: true })
  if (error) throw error
  return ((data ?? []) as unknown as Row[]).map((row) => ({
    codeId: String(row.time_code_id),
    date: String(row.work_date),
    hours: number(row.hours),
  }))
}

export async function loadTimeComments(workspaceId: string, month: string): Promise<TimeComment[]> {
  const { data, error } = await neon.from('time_code_month_comments')
    .select('time_code_id,month_start,comment')
    .eq('workspace_id', workspaceId)
    .eq('month_start', `${month}-01`)
  if (error) throw error
  return ((data ?? []) as unknown as Row[]).map((row) => ({
    codeId: String(row.time_code_id),
    month: String(row.month_start).slice(0, 7),
    comment: String(row.comment),
  }))
}

export async function createTimeCode(workspaceId: string, code: TimeCode) {
  const { error } = await neon.from('time_codes').insert({
    id: code.id,
    workspace_id: workspaceId,
    name: code.name.normalize('NFKC').trim(),
    sort_order: code.sortOrder,
    client_id: code.clientId ?? null,
    hidden_from_month: code.hiddenFromMonth ? `${code.hiddenFromMonth}-01` : null,
  })
  if (error) throw error
}

export async function updateTimeCode(workspaceId: string, code: TimeCode) {
  const name = code.name.normalize('NFKC').trim()
  if (!name) throw new Error('A time code name is required.')
  const { data, error } = await neon.from('time_codes').update({
    name,
    client_id: code.clientId ?? null,
    hidden_from_month: code.hiddenFromMonth ? `${code.hiddenFromMonth}-01` : null,
  }).eq('workspace_id', workspaceId).eq('id', code.id).select('id')
  if (error) throw error
  if (!data?.length) throw new Error('The time code could not be updated.')
}

export async function createTimesheetClient(workspaceId: string, client: TimesheetClient, initialRate: TimesheetClientRate) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { error } = await neon.rpc('create_timesheet_client', {
      p_workspace_id: workspaceId,
      p_client_id: client.id,
      p_name: client.name.normalize('NFKC').trim(),
      p_currency: client.currency.toUpperCase(),
      p_sort_order: client.sortOrder,
      p_effective_from: initialRate.effectiveFrom,
      p_hourly_rate_minor: initialRate.hourlyRateMinor,
    })
    if (!error) return

    const transientAuthorizationFailure = error.code === '42501'
      && error.message.includes('access to this workspace')
    if (!transientAuthorizationFailure || attempt === 2) throw error

    await neon.auth.getSession()
    await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)))
  }
}

export async function updateTimesheetClient(workspaceId: string, client: TimesheetClient) {
  const { data, error } = await neon.from('timesheet_clients').update({
    name: client.name.normalize('NFKC').trim(),
    currency: client.currency.toUpperCase(),
    active: client.active,
  }).eq('workspace_id', workspaceId).eq('id', client.id).select('id')
  if (error) throw error
  if (!data?.length) throw new Error('The client could not be updated.')
}

export async function saveTimesheetClientRate(workspaceId: string, rate: TimesheetClientRate) {
  const { error } = await neon.from('timesheet_client_rates').upsert({
    workspace_id: workspaceId,
    client_id: rate.clientId,
    effective_from: rate.effectiveFrom,
    hourly_rate_minor: rate.hourlyRateMinor,
  }, { onConflict: 'workspace_id,client_id,effective_from' })
  if (error) throw error
}

export async function saveTimesheetClientForecast(workspaceId: string, forecast: TimesheetClientForecast) {
  const { error } = await neon.from('timesheet_client_forecasts').upsert({
    workspace_id: workspaceId,
    client_id: forecast.clientId,
    forecast_year: forecast.year,
    hours_per_day: forecast.hoursPerDay,
    vacation_days_remaining: forecast.vacationDaysRemaining,
  }, { onConflict: 'workspace_id,client_id,forecast_year' })
  if (error) throw error
}

export async function saveTimeCodeOrder(workspaceId: string, timeCodeIds: string[]) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { error } = await neon.rpc('save_time_code_order', {
      p_workspace_id: workspaceId,
      p_time_code_ids: timeCodeIds,
    })
    if (!error) return
    const transientAuthorizationFailure = error.code === '42501'
      && error.message.includes('access to this workspace')
    if (!transientAuthorizationFailure || attempt === 2) throw error
    await neon.auth.getSession()
    await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)))
  }
}

export async function saveTimeComment(workspaceId: string, value: TimeComment) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { error } = await neon.rpc('save_time_code_month_comment', {
      p_workspace_id: workspaceId,
      p_time_code_id: value.codeId,
      p_month_start: `${value.month}-01`,
      p_comment: value.comment,
    })
    if (!error) return
    const transientAuthorizationFailure = error.code === '42501'
      && error.message.includes('access to this workspace')
    if (!transientAuthorizationFailure || attempt === 2) throw error
    await neon.auth.getSession()
    await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)))
  }
}

export async function saveTimeEntry(workspaceId: string, entry: TimeEntry) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { error } = await neon.rpc('save_time_entry', {
      p_workspace_id: workspaceId,
      p_time_code_id: entry.codeId,
      p_work_date: entry.date,
      p_hours: entry.hours,
    })
    if (!error) return

    const transientAuthorizationFailure = error.code === '42501'
      && error.message.includes('access to this workspace')
    if (!transientAuthorizationFailure || attempt === 2) throw error

    // Neon injects the session token lazily for each Data API request. A
    // session refresh plus a short retry handles the occasional request that
    // reaches Postgres without its user context, without retrying other errors.
    await neon.auth.getSession()
    await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)))
  }
}
