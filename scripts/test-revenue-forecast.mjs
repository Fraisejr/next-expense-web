import assert from 'node:assert/strict'
import { calculateRevenueForecast, calendarWorkWeeksRemaining, nextMonday, revenueRecognitionDate } from '../src/revenue.ts'

assert.equal(nextMonday('2026-09-18'), '2026-09-21')
assert.equal(nextMonday('2026-09-20'), '2026-09-21')
assert.equal(revenueRecognitionDate('2025-12-31'), '2026-01-01')
assert.equal(revenueRecognitionDate('2026-01-05'), '2026-02-01')
assert.equal(calendarWorkWeeksRemaining('2026-09-18', 2026), 10.2)
assert.equal(calendarWorkWeeksRemaining('2026-12-31', 2026), 0)
assert.equal(calendarWorkWeeksRemaining('2026-09-18', 2025), 0)

const result = calculateRevenueForecast({
  clients: [{ id: 'client', name: 'Client', currency: 'EUR', sortOrder: 0, active: true }],
  rates: [{ clientId: 'client', effectiveFrom: '2026-01-01', hourlyRateMinor: 10000 }],
  forecasts: [{ clientId: 'client', year: 2026, weeklyHours: 20, vacationWeeks: 1 }],
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

assert.equal(result.actualRevenueMinor, 100000)
assert.equal(result.clients[0].actualHours, 10)
assert.equal(result.clients[0].pendingHours, 3)
assert.equal(result.clients[0].pendingRevenueMinor, 30000)
assert.equal(result.clients[0].calendarWeeksRemaining, 10.2)
assert.equal(result.clients[0].workWeeksRemaining, 9.2)
assert.equal(result.clients[0].forecastHours, 184)
assert.equal(result.remainingRevenueMinor, 1870000)
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
