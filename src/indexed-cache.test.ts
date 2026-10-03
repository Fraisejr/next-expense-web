import assert from 'node:assert/strict'
import test from 'node:test'
import { accessIndexedCache } from './indexed-cache.ts'

test('denied browser storage behaves as an optional cache miss', async (t) => {
  globalThis.indexedDB = { open: () => { throw new Error('Storage denied') } } as unknown as IDBFactory
  t.after(() => Reflect.deleteProperty(globalThis, 'indexedDB'))
  assert.equal(await accessIndexedCache('db', 'store', 'readonly', () => { throw new Error('Unexpected action') }), null)
})

test('stalled browser storage times out and closes a late connection', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let closed = false
  const request = { result: { close: () => { closed = true } }, onsuccess: () => {} }
  globalThis.indexedDB = { open: () => request } as unknown as IDBFactory
  t.after(() => Reflect.deleteProperty(globalThis, 'indexedDB'))
  const pending = accessIndexedCache('db', 'store', 'readonly', () => { throw new Error('Late connection must not be used') })
  t.mock.timers.tick(2000)
  assert.equal(await pending, null)
  request.onsuccess()
  assert.equal(closed, true)
})
