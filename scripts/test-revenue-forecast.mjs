import assert from 'node:assert/strict'
import { calculateRevenueForecast, calendarWorkDaysRemaining, earnedWorkMonthRange, revenueRecognitionDate } from '../src/revenue.ts'

assert.equal(revenueRecognitionDate('2025-12-31'), '2026-01-01')
assert.equal(revenueRecognitionDate('2026-01-05'), '2026-02-01')
assert.deepEqual(earnedWorkMonthRange('2026-09-18', 2026), { startMonth: '2025-12', endMonth: '2026-09' })
assert.deepEqual(earnedWorkMonthRange('2026-10-01', 2026), { startMonth: '2025-12', endMonth: '2026-10' })
assert.deepEqual(earnedWorkMonthRange('2027-01-01', 2026), { startMonth: '2025-12', endMonth: '2026-11' })
assert.equal(earnedWorkMonthRange('2025-11-30', 2026), null)
assert.equal(calendarWorkDaysRemaining('2026-09-18', 2026), 51)
assert.equal(calendarWorkDaysRemaining('2026-12-31', 2026), 0)
assert.equal(calendarWorkDaysRemaining('2026-09-18', 2025), 0)

const result = calculateRevenueForecast({
  clients: [{ id: 'client', name: 'Client', currency: 'EUR', sortOrder: 0, active: true }],
  rates: [{ clientId: 'client', effectiveFrom: '2026-01-01', hourlyRateMinor: 10000 }],
  forecasts: [{ clientId: 'client', year: 2026, hoursPerDay: 4, vacationDaysRemaining: 5 }],
  timeCodes: [{ id: 'delivery', name: 'Delivery', sortOrder: 0, clientId: 'client' }],
  entries: [
    { codeId: 'delivery', date: '2025-12-05', hours: 8 },
    { codeId: 'delivery', date: '2026-01-05', hours: 2 },
    { codeId: 'delivery', date: '2026-09-05', hours: 3 },
    { codeId: 'delivery', date: '2026-12-05', hours: 8 },
    { codeId: 'delivery', date: '2027-01-05', hours: 8 },
  ],
  fxRates: [],
  defaultCurrency: 'EUR',
  today: '2026-09-18',
  year: 2026,
})

assert.equal(result.actualRevenueMinor, 130000)
assert.equal(result.clients[0].actualHours, 13)
assert.equal(result.clients[0].calendarWorkDaysRemaining, 51)
assert.equal(result.clients[0].workDaysRemaining, 46)
assert.equal(result.clients[0].forecastHours, 184)
assert.equal(result.remainingRevenueMinor, 1840000)
assert.equal(result.fullYearRevenueMinor, 1970000)
assert.equal(result.missingFx, false)
assert.equal(result.missingRate, false)

const history = calculateRevenueForecast({
  clients: [{ id: 'history', name: 'History', currency: 'EUR', sortOrder: 0, active: true }],
  rates: [
    { clientId: 'history', effectiveFrom: '2026-01-01', hourlyRateMinor: 10000 },
    { clientId: 'history', effectiveFrom: '2026-07-01', hourlyRateMinor: 20000 },
  ],
  forecasts: [],
  timeCodes: [{ id: 'consulting', name: 'Consulting', sortOrder: 0, clientId: 'history' }],
  entries: [
    { codeId: 'consulting', date: '2025-12-05', hours: 8 },
    { codeId: 'consulting', date: '2026-06-05', hours: 2 },
    { codeId: 'consulting', date: '2026-12-05', hours: 5 },
  ],
  fxRates: [],
  defaultCurrency: 'EUR',
  today: '2026-12-31',
  year: 2026,
})

assert.equal(history.actualRevenueMinor, 120000)
assert.equal(history.remainingRevenueMinor, 0)

console.log('Revenue forecast calculations passed')
