import { convertMinor } from './currency.ts'
import type { FxRate, TimeCode, TimeEntry, TimesheetClient, TimesheetClientForecast, TimesheetClientRate } from './types.ts'

export type ClientRevenueForecast = {
  client: TimesheetClient
  actualHours: number
  actualRevenueMinor: number
  calendarWeeksRemaining: number
  workWeeksRemaining: number
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

export function nextMonday(date: string) {
  const value = parseDate(date)
  const weekday = value.getUTCDay()
  const daysUntilMonday = weekday === 0 ? 1 : 8 - weekday
  value.setUTCDate(value.getUTCDate() + daysUntilMonday)
  return dateKey(value)
}

export function calendarWorkWeeksRemaining(today: string, year: number) {
  const todayYear = Number(today.slice(0, 4))
  if (year < todayYear) return 0
  const start = year === todayYear ? parseDate(nextMonday(today)) : new Date(Date.UTC(year, 0, 1))
  const end = new Date(Date.UTC(year, 11, 31))
  if (start > end) return 0
  let weekdays = 0
  for (const day = new Date(start); day <= end; day.setUTCDate(day.getUTCDate() + 1)) {
    const weekday = day.getUTCDay()
    if (weekday !== 0 && weekday !== 6) weekdays += 1
  }
  return weekdays / 5
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
  const yearStart = `${year}-01-01`
  const yearEnd = `${year}-12-31`
  const calendarWeeks = calendarWorkWeeksRemaining(today, year)

  const clientResults = clients.map((client) => {
    let actualHours = 0
    let actualRevenueMinor = 0
    let missingFx = false
    let missingRate = false

    for (const entry of entries) {
      if (entry.date < yearStart || entry.date > yearEnd || entry.date > today || codeClient.get(entry.codeId) !== client.id) continue
      actualHours += entry.hours
      const rate = applicableRate(client.id, entry.date, rates)
      if (!rate) {
        missingRate = true
        continue
      }
      const converted = convertRevenue(Math.round(entry.hours * rate.hourlyRateMinor), client.currency, defaultCurrency, entry.date, fxRates)
      if (converted === null) missingFx = true
      else actualRevenueMinor += converted
    }

    const assumptions = client.active ? forecasts.find((forecast) => forecast.clientId === client.id && forecast.year === year) : undefined
    const workWeeksRemaining = Math.max(0, calendarWeeks - (assumptions?.vacationWeeks ?? 0))
    const forecastHours = (assumptions?.weeklyHours ?? 0) * workWeeksRemaining
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
      calendarWeeksRemaining: calendarWeeks,
      workWeeksRemaining,
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
