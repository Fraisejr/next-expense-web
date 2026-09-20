import { PostgrestClient } from '@supabase/postgrest-js'
import { randomUUID } from 'node:crypto'
import { BankHttpError } from './bank-authorization.ts'
import type { BankDatabase } from '../shared/bank-data.ts'

type Row = Record<string, unknown>
export function bankClient(url: string, authorization: string) {
  const deadline = Date.now() + 270_000
  return new PostgrestClient(url, {
    headers: { Authorization: authorization },
    fetch: (input, init) => {
      if (Date.now() >= deadline) throw new Error('Bank sync took too long. Refresh to check saved results before syncing again.')
      return fetch(input, { ...init, signal: AbortSignal.timeout(Math.min(15_000, deadline - Date.now())) })
    },
  })
}

// Compare-and-swap on the connection row works across server instances. The
// updated_at is maintained by the database trigger, so large bank payloads
// never need to be sent in a URL filter. The lease outlives Vercel's 300-second execution limit, including abandoned calls.
export async function acquireSyncLease(db: BankDatabase, workspaceId: string, accountId: string) {
  const query = () => db.from('bank_connections').select('id,metadata,last_synced_at,updated_at')
    .eq('workspace_id', workspaceId).eq('account_id', accountId)
    .eq('provider', 'gocardless_bank_account_data').eq('status', 'active').limit(1)
  const initial = await query()
  if (initial.error) throw initial.error
  const connection = initial.data?.[0] as Row | undefined
  if (!connection) throw new BankHttpError('Reconnect this account on the website before syncing.', 409)
  const metadata = (connection.metadata ?? {}) as Row
  const previous = metadata.sync_lease as { expiresAt?: number } | undefined
  if ((previous?.expiresAt ?? 0) > Date.now()) throw new BankHttpError('This account is already syncing. Refresh in a moment.', 409)
  const id = randomUUID()
  const update = db.from('bank_connections').update({ metadata: { ...metadata, sync_lease: { id, expiresAt: Date.now() + 360_000 } } })
    .eq('workspace_id', workspaceId).eq('id', connection.id).eq('updated_at', connection.updated_at)
  const claimed = await update.select('id')
  if (claimed.error) throw claimed.error
  if (!claimed.data?.length) throw new BankHttpError('This account changed or is already syncing. Refresh and try again.', 409)
  return async () => {
    const latest = await query()
    if (latest.error) throw latest.error
    const row = latest.data?.[0] as Row | undefined
    const current = row?.metadata as Row | undefined
    if ((current?.sync_lease as { id?: string } | undefined)?.id !== id) return
    const remaining = { ...current }; delete remaining.sync_lease
    const released = await db.from('bank_connections').update({ metadata: remaining })
      .eq('workspace_id', workspaceId).eq('id', connection.id).eq('updated_at', row!.updated_at)
    if (released.error) throw released.error
  }
}

type AutomaticSyncResult = {
  date: string
  status: 'running' | 'completed' | 'failed'
  startedAt: string
  completedAt?: string
  error?: string
  imported?: number
  warnings?: string[]
}

async function connectionForUpdate(db: BankDatabase, workspaceId: string, accountId: string) {
  const result = await db.from('bank_connections').select('id,metadata,updated_at')
    .eq('workspace_id', workspaceId).eq('account_id', accountId)
    .eq('provider', 'gocardless_bank_account_data').eq('status', 'active').limit(1)
  if (result.error) throw result.error
  return result.data?.[0] as Row | undefined
}

export async function claimAutomaticSync(db: BankDatabase, workspaceId: string, accountId: string, date: string, startedAt: string) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const connection = await connectionForUpdate(db, workspaceId, accountId)
    if (!connection) throw new BankHttpError('Reconnect this account on the website before syncing.', 409)
    const metadata = (connection.metadata ?? {}) as Row
    const previous = metadata.last_automatic_sync as AutomaticSyncResult | undefined
    if (previous?.date === date) return false
    const update = await db.from('bank_connections').update({
      metadata: { ...metadata, last_automatic_sync: { date, status: 'running', startedAt } satisfies AutomaticSyncResult },
    }).eq('workspace_id', workspaceId).eq('id', connection.id).eq('updated_at', connection.updated_at).select('id')
    if (update.error) throw update.error
    if (update.data?.length) return true
  }
  throw new BankHttpError('This account changed while automatic sync was starting.', 409)
}

export async function finishAutomaticSync(db: BankDatabase, workspaceId: string, accountId: string, result: AutomaticSyncResult) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const connection = await connectionForUpdate(db, workspaceId, accountId)
    if (!connection) return
    const metadata = (connection.metadata ?? {}) as Row
    const update = await db.from('bank_connections').update({
      metadata: { ...metadata, last_automatic_sync: result },
    }).eq('workspace_id', workspaceId).eq('id', connection.id).eq('updated_at', connection.updated_at).select('id')
    if (update.error) throw update.error
    if (update.data?.length) return
  }
  throw new Error('Could not save the automatic bank sync result.')
}
