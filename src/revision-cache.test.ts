import assert from 'node:assert/strict'
import test from 'node:test'
import { loadRevisionCached } from './revision-cache.ts'

test('unchanged revision reuses cached history without a download or age limit', async () => {
  const value = await loadRevisionCached({ revision: async () => 7, read: async () => ({ revision: 7, value: ['cached'] }),
    load: async () => { throw new Error('Unexpected download') }, write: async () => { throw new Error('Unexpected write') } })
  assert.deepEqual(value, ['cached'])
})

test('changed revision downloads again and caches only a stable snapshot', async () => {
  const revisions = [8, 9, 9]
  let loads = 0
  const writes: unknown[] = []
  const value = await loadRevisionCached({ revision: async () => revisions.shift()!, read: async () => ({ revision: 7, value: [0] }),
    load: async () => [++loads], write: async (cached) => { writes.push(cached) } })
  assert.deepEqual(value, [2])
  assert.deepEqual(writes, [{ revision: 9, value: [2] }])
})

test('continuous changes and failed revision checks never cache uncertain rows', async () => {
  let revision = 0
  let writes = 0
  const services = { read: async () => null, load: async () => ['rows'], write: async () => { writes++ } }
  await assert.rejects(loadRevisionCached({ ...services, revision: async () => ++revision }), /changed while loading/)
  await assert.rejects(loadRevisionCached({ ...services, revision: async () => { throw new Error('Offline') } }), /Offline/)
  assert.equal(writes, 0)
})
