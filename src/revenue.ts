import { convertMinor } from './currency.ts'
import type { FxRate, TimeCode, TimeEntry, TimesheetClient, TimesheetClientForecast, TimesheetClientRate } from './types.ts'

export type ClientRevenueForecast = {
  client: TimesheetClient
  actualHours: number
  actualRevenueMinor: number
  calendarWorkDaysRemaining: number
  workDaysRemaining: number
  forecastHours: number
  remainingRevenueMinor: number
  fullYearRevenueMinor: number
  missingFx: boolean
  missingRate: boolean
}

export type RevenueForecast = {
  clients: ClientRevenueForecast[]
  actualRevenueMinor: number
  remainingRevenueMinor: number
  fullYearRevenueMinor: number
  missingFx: boolean
  missingRate: boolean
}

function parseDate(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day))
}

function dateKey(value: Date) {
  return value.toISOString().slice(0, 10)
}

function monthKey(value: Date) {
  return value.toISOString().slice(0, 7)
}

export function revenueRecognitionDate(workDate: string) {
  const [year, month] = workDate.split('-').map(Number)
  return dateKey(new Date(Date.UTC(year, month, 1)))
}

export function earnedWorkMonthRange(today: string, year: number) {
  const [todayYear, todayMonth] = today.split('-').map(Number)
  const start = new Date(Date.UTC(year - 1, 11, 1))
  const currentMonth = new Date(Date.UTC(todayYear, todayMonth - 1, 1))
  const lastMonthForYear = new Date(Date.UTC(year, 10, 1))
  const end = currentMonth < lastMonthForYear ? currentMonth : lastMonthForYear
  if (end < start) return null
  return { startMonth: monthKey(start), endMonth: monthKey(end) }
}

export function calendarWorkDaysRemaining(today: string, year: number) {
  const workPeriodStart = new Date(Date.UTC(year - 1, 11, 1))
  const tomorrow = parseDate(today)
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
  const start = tomorrow > workPeriodStart ? tomorrow : workPeriodStart
  const end = new Date(Date.UTC(year, 10, 30))
  if (start > end) return 0
  let weekdays = 0
  for (const day = new Date(start); day <= end; day.setUTCDate(day.getUTCDate() + 1)) {
    const weekday = day.getUTCDay()
    if (weekday !== 0 && weekday !== 6) weekdays += 1
  }
  return weekdays
}

function applicableRate(clientId: string, date: string, rates: TimesheetClientRate[]) {
  return rates
    .filter((rate) => rate.clientId === clientId && rate.effectiveFrom <= date)
    .sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom))[0]
}

function convertRevenue(amountMinor: number, currency: string, defaultCurrency: string, date: string, fxRates: FxRate[]) {
  return convertMinor(amountMinor, currency, defaultCurrency, date, fxRates)
}

export function calculateRevenueForecast({
  clients,
  rates,
  forecasts,
  timeCodes,
  entries,
  fxRates,
  defaultCurrency,
  today,
  year,
}: {
  clients: TimesheetClient[]
  rates: TimesheetClientRate[]
  forecasts: TimesheetClientForecast[]
  timeCodes: TimeCode[]
  entries: TimeEntry[]
  fxRates: FxRate[]
  defaultCurrency: string
  today: string
  year: number
}): RevenueForecast {
  const codeClient = new Map(timeCodes.filter((code) => code.clientId).map((code) => [code.id, code.clientId!]))
  const workPeriodStart = `${year - 1}-12-01`
  const workPeriodEnd = `${year}-11-30`
  const calendarWorkDays = calendarWorkDaysRemaining(today, year)

  const clientResults = clients.map((client) => {
    let actualHours = 0
    let actualRevenueMinor = 0
    let missingFx = false
    let missingRate = false

    for (const entry of entries) {
      const recognitionDate = revenueRecognitionDate(entry.date)
      if (entry.date < workPeriodStart || entry.date > workPeriodEnd || entry.date > today || codeClient.get(entry.codeId) !== client.id) continue
      actualHours += entry.hours
      const rate = applicableRate(client.id, recognitionDate, rates)
      if (!rate) {
        missingRate = true
        continue
      }
      const converted = convertRevenue(Math.round(entry.hours * rate.hourlyRateMinor), client.currency, defaultCurrency, recognitionDate, fxRates)
      if (converted === null) missingFx = true
      else actualRevenueMinor += converted
    }

    const assumptions = client.active ? forecasts.find((forecast) => forecast.clientId === client.id && forecast.year === year) : undefined
    const workDaysRemaining = Math.max(0, calendarWorkDays - (assumptions?.vacationDaysRemaining ?? 0))
    const forecastHours = (assumptions?.hoursPerDay ?? 0) * workDaysRemaining
    const currentRate = applicableRate(client.id, today, rates)
    if (!currentRate && forecastHours > 0) missingRate = true
    const nativeRemainingRevenue = currentRate ? Math.round(forecastHours * currentRate.hourlyRateMinor) : 0
    const convertedRemaining = convertRevenue(nativeRemainingRevenue, client.currency, defaultCurrency, today, fxRates)
    if (convertedRemaining === null && nativeRemainingRevenue > 0) missingFx = true
    const remainingRevenueMinor = convertedRemaining ?? 0

    return {
      client,
      actualHours,
      actualRevenueMinor,
      calendarWorkDaysRemaining: calendarWorkDays,
      workDaysRemaining,
      forecastHours,
      remainingRevenueMinor,
      fullYearRevenueMinor: actualRevenueMinor + remainingRevenueMinor,
      missingFx,
      missingRate,
    }
  })

  return {
    clients: clientResults,
    actualRevenueMinor: clientResults.reduce((sum, item) => sum + item.actualRevenueMinor, 0),
    remainingRevenueMinor: clientResults.reduce((sum, item) => sum + item.remainingRevenueMinor, 0),
    fullYearRevenueMinor: clientResults.reduce((sum, item) => sum + item.fullYearRevenueMinor, 0),
    missingFx: clientResults.some((item) => item.missingFx),
    missingRate: clientResults.some((item) => item.missingRate),
  }
}
