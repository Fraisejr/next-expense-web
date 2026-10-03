import assert from 'node:assert/strict'
import test from 'node:test'
import { createTimesheetYearCache, revenueYearForDate } from './year-cache.ts'
import type { TimeEntry } from '../../types'

test('months in the same year share a load; years and workspaces stay separate', async () => {
  let loads = 0
  const cache = createTimesheetYearCache(async () => { loads++; return [] })
  await Promise.all([cache.load('a', 2026), cache.load('a', 2026)])
  await cache.load('a', 2026)
  assert.equal(loads, 1)
  await cache.load('a', 2027)
  await cache.load('b', 2026)
  assert.equal(loads, 3)
  assert.equal(revenueYearForDate('2025-12-31'), 2026)
  assert.equal(revenueYearForDate('2026-11-30'), 2026)
  assert.equal(revenueYearForDate('2026-12-01'), 2027)
})

test('confirmed saves during a load override fetched hours, including deletion', async () => {
  let finish!: (entries: TimeEntry[]) => void
  const cache = createTimesheetYearCache(() => new Promise((resolve) => { finish = resolve }))
  const pending = cache.load('a', 2026)
  const entry = { codeId: 'code', date: '2025-12-02', hours: 8 }
  cache.saved('a', entry)
  finish([{ ...entry, hours: 2 }])
  assert.deepEqual(await pending, [entry])
  cache.saved('a', { ...entry, hours: 0 })
  assert.deepEqual(await cache.load('a', 2026), [])
})

test('failed requests can retry and invalidation forces a new read', async () => {
  let loads = 0
  const cache = createTimesheetYearCache(async () => { if (++loads === 1) throw new Error('Offline'); return [] })
  await assert.rejects(cache.load('a', 2026), /Offline/)
  await cache.load('a', 2026)
  cache.invalidate('a', 2026)
  await cache.load('a', 2026)
  assert.equal(loads, 3)
})
