import { neon } from '../../neon'
import { isExpiredJwtError } from '../../auth-bootstrap'
import type { TimeCode, TimeComment, TimeEntry, TimesheetClient, TimesheetClientForecast, TimesheetClientRate } from '../../types'

type Row = Record<string, unknown>
const number = (value: unknown) => Number(value ?? 0)

// Verify membership in the same request that reads the hours and comments.
// Missing user context must never look like an empty timesheet.
async function readTimesheet(workspaceId: string, startDate: string, endDate: string, commentMonth: string | null = null) {
  for (let attempt = 0; ; attempt++) {
    const { data, error } = await neon.rpc('read_timesheet', {
      p_workspace_id: workspaceId,
      p_start_date: startDate,
      p_end_date: endDate,
      // GET encodes arguments in the URL. Omit null so Postgres uses the
      // function's default, rather than parsing the literal string "null".
      ...(commentMonth ? { p_comment_month: commentMonth } : {}),
    }, { get: true }).abortSignal(AbortSignal.timeout(30_000))
    if (error) {
      const authFailure = error.code === '42501' && error.message.includes('access to this workspace')
        || isExpiredJwtError(error)
      // An API instance may still have an old function cache during startup
      // or migration rollout. This read is safe to replay, with a strict limit.
      const missingReadFunction = error.code === 'PGRST202' && error.message.includes('read_timesheet')
      if (missingReadFunction) {
        if (attempt >= 2) throw new Error('The timesheet service is temporarily unavailable. Please retry loading hours.', { cause: error })
        await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)))
        continue
      }
      if (!authFailure || attempt >= 2) throw error
      const refreshed = await neon.auth.getSession()
      if (refreshed.error) throw refreshed.error
      if (!refreshed.data) throw new Error('Your session could not be verified. Retry loading your timesheet.')
      await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)))
      continue
    }
    const result = data as unknown as { workspaceId?: string; entries?: Row[]; comments?: Row[] } | null
    if (result?.workspaceId !== workspaceId || !Array.isArray(result.entries) || !Array.isArray(result.comments)) {
      throw new Error('The timesheet response could not be verified. Retry loading your timesheet.')
    }
    return {
      entries: result.entries.map(row => ({ codeId: String(row.time_code_id), date: String(row.work_date), hours: number(row.hours) })),
      comments: result.comments.map(row => ({ codeId: String(row.time_code_id), month: String(row.month_start).slice(0, 7), comment: String(row.comment) })),
    }
  }
}

export async function loadTimesheetMonth(workspaceId: string, month: string): Promise<{ entries: TimeEntry[]; comments: TimeComment[] }> {
  const startDate = month + '-01'
  const nextMonth = new Date(startDate + 'T12:00:00Z')
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1)
  return readTimesheet(workspaceId, startDate, nextMonth.toISOString().slice(0, 10), startDate)
}

export async function loadTimeEntries(workspaceId: string, month: string): Promise<TimeEntry[]> {
  return (await loadTimesheetMonth(workspaceId, month)).entries
}

export async function loadRevenueRecognitionEntries(workspaceId: string, year: number): Promise<TimeEntry[]> {
  return (await readTimesheet(workspaceId, (year - 1) + '-12-01', year + '-12-01')).entries
}

export async function loadTimeComments(workspaceId: string, month: string): Promise<TimeComment[]> {
  return (await loadTimesheetMonth(workspaceId, month)).comments
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
    kleer_project: code.kleerMapping?.project.trim() || null,
    kleer_activity: code.kleerMapping?.activity.trim() || null,
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
