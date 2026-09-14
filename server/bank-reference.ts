import type { BankDatabase } from '../shared/bank-data.ts'

type BankReference = {
  workspace_id: string
  account_id: string
  transaction_id: string
  provider: string
  provider_transaction_id: string
  bank_transaction_id: string | null
}

// A reference can be created by Review or another account's transfer sync
// after the initial snapshot. Never overwrite its existing transaction owner.
export async function saveTransferReference(db: BankDatabase, reference: BankReference): Promise<boolean> {
  const inserted = await db.from('bank_transaction_refs').insert({ id: crypto.randomUUID(), ...reference })
  if (!inserted.error) return true
  if (inserted.error.code !== '23505') throw inserted.error

  const owners = new Set<string>()
  for (const column of ['provider_transaction_id', 'bank_transaction_id'] as const) {
    const value = reference[column]
    if (!value) continue
    const found = await db.from('bank_transaction_refs').select('transaction_id')
      .eq('workspace_id', reference.workspace_id).eq('account_id', reference.account_id)
      .eq('provider', reference.provider).eq(column, value)
    if (found.error) throw found.error
    for (const row of found.data ?? []) owners.add(String(row.transaction_id))
  }
  // Do not swallow an unrelated constraint violation or inaccessible reference.
  if (!owners.size) throw inserted.error
  return owners.size === 1 && owners.has(reference.transaction_id)
}
