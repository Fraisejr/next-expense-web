import assert from 'node:assert/strict'
import test from 'node:test'
import { loadCurrentTransactionHistory } from './transaction-history-request.ts'

test('a refresh arriving during history loading retries and applies only current history', async () => {
  let generation = 0
  const applied: string[][] = []
  const loads: boolean[] = []
  await loadCurrentTransactionHistory({
    generation: () => generation,
    load: async (revalidate) => {
      loads.push(revalidate)
      if (!revalidate) { generation++; return ['stale'] }
      return ['current']
    },
    apply: (value) => { applied.push(value) },
  })
  assert.deepEqual(loads, [false, true])
  assert.deepEqual(applied, [['current']])
})

test('a stalled load times out, permits a retry, and cannot overwrite its result later', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let finish!: (value: string[]) => void
  const stalled = new Promise<string[]>((resolve) => { finish = resolve })
  const applied: string[][] = []
  const request = loadCurrentTransactionHistory({ load: () => stalled, generation: () => 0, apply: (value) => { applied.push(value) } })
  const rejected = assert.rejects(request, /took too long.*retry/)
  t.mock.timers.tick(30_000)
  await rejected
  await loadCurrentTransactionHistory({ load: async () => ['retried'], generation: () => 0, apply: (value) => { applied.push(value) } })
  finish(['late stale result'])
  await stalled
  assert.deepEqual(applied, [['retried']])
})

test('repeated refreshes finish with an actionable error rather than applying stale history', async () => {
  let generation = 0
  let applied = false
  await assert.rejects(loadCurrentTransactionHistory({
    load: async () => { generation++; return ['stale'] },
    generation: () => generation,
    apply: () => { applied = true },
  }), /changed during.*retry/)
  assert.equal(applied, false)
})

test('failed history requests preserve existing data', async () => {
  let displayed = ['existing']
  await assert.rejects(loadCurrentTransactionHistory({
    load: async () => { throw new Error('Network unavailable') },
    generation: () => 0,
    apply: (value: string[]) => { displayed = value },
  }), /Network unavailable/)
  assert.deepEqual(displayed, ['existing'])
})
