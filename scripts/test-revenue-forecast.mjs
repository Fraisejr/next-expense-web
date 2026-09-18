import assert from 'node:assert/strict'
import { calculateRevenueForecast, calendarWorkWeeksRemaining, nextMonday } from '../src/revenue.ts'

assert.equal(nextMonday('2026-09-18'), '2026-09-21')
assert.equal(nextMonday('2026-09-20'), '2026-09-21')
assert.equal(calendarWorkWeeksRemaining('2026-12-31', 2026), 0)
assert.equal(calendarWorkWeeksRemaining('2026-09-18', 2025), 0)

const result = calculateRevenueForecast({
  clients: [{ id: 'client', name: 'Client', currency: 'EUR', sortOrder: 0, active: true }],
  rates: [{ clientId: 'client', effectiveFrom: '2026-01-01', hourlyRateMinor: 10000 }],
  forecasts: [{ clientId: 'client', year: 2026, weeklyHours: 20, vacationWeeks: 1 }],
  timeCodes: [{ id: 'delivery', name: 'Delivery', sortOrder: 0, clientId: 'client' }],
  entries: [
    { codeId: 'delivery', date: '2026-01-05', hours: 8 },
    { codeId: 'delivery', date: '2027-01-05', hours: 8 },
  ],
  fxRates: [],
  defaultCurrency: 'EUR',
  today: '2026-12-18',
  year: 2026,
})

assert.equal(result.actualRevenueMinor, 80000)
assert.equal(result.clients[0].calendarWeeksRemaining, 1.8)
assert.equal(result.clients[0].workWeeksRemaining, 0.8)
assert.equal(result.clients[0].forecastHours, 16)
assert.equal(result.remainingRevenueMinor, 160000)
assert.equal(result.fullYearRevenueMinor, 240000)
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
    { codeId: 'consulting', date: '2026-01-05', hours: 8 },
    { codeId: 'consulting', date: '2026-08-05', hours: 2 },
  ],
  fxRates: [],
  defaultCurrency: 'EUR',
  today: '2026-12-31',
  year: 2026,
})

assert.equal(history.actualRevenueMinor, 120000)
assert.equal(history.remainingRevenueMinor, 0)

console.log('Revenue forecast calculations passed')
