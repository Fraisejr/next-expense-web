import test from 'node:test'
import assert from 'node:assert/strict'
import { bankClient } from './bank-sync.ts'
import { saveTransferReference } from './bank-reference.ts'

const reference = { workspace_id: 'workspace', account_id: 'account', transaction_id: 'transfer', provider: 'gocardless_bank_account_data', provider_transaction_id: 'provider-id', bank_transaction_id: 'bank-id' }
for (const owner of ['transfer', 'previously-matched-transaction']) {
  test(`a reference inserted after the snapshot preserves owner ${owner}`, async t => {
    const original = globalThis.fetch
    const methods: string[] = []
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input)); methods.push(init?.method ?? 'GET')
      if (init?.method === 'POST') return Response.json({ code: '23505', message: 'duplicate key value violates unique constraint "bank_transaction_refs_provider_id_idx"' }, { status: 409 })
      assert.equal(url.searchParams.get('workspace_id'), 'eq.workspace')
      assert.equal(url.searchParams.get('account_id'), 'eq.account')
      assert.equal(url.searchParams.get('provider'), 'eq.gocardless_bank_account_data')
      return Response.json([{ transaction_id: owner }])
    }
    t.after(() => { globalThis.fetch = original })
    const saved = await saveTransferReference(bankClient('https://data.example', 'Bearer fixture'), reference)
    assert.equal(saved, owner === 'transfer')
    assert.deepEqual(methods, ['POST', 'GET', 'GET'], 'no overwrite or deletion')
  })
}

test('unrelated database errors still fail the import', async t => {
  const original = globalThis.fetch
  globalThis.fetch = async () => Response.json({ code: '42501', message: 'Access denied' }, { status: 403 })
  t.after(() => { globalThis.fetch = original })
  await assert.rejects(saveTransferReference(bankClient('https://data.example', 'Bearer fixture'), reference), { code: '42501' })
})
