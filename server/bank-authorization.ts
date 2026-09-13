import type { IncomingMessage } from 'node:http'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

export class BankHttpError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}

export type BankServerConfig = {
  dataApiUrl?: string
  appUrl?: string
}

export function assertUUID(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new BankHttpError(`${label} is invalid.`, 400)
  }
  return value.toLowerCase()
}

export function allowedOrigin(origin: string, config: BankServerConfig): boolean {
  if (config.appUrl) return origin === new URL(config.appUrl).origin
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
}

export async function authorizeBankRequest(request: IncomingMessage, workspace: unknown, account: unknown, config: BankServerConfig) {
  const authorization = request.headers.authorization
  if (!authorization?.startsWith('Bearer ') || authorization.length > 16_384) throw new BankHttpError('Sign in to access bank connections.', 401)
  if (!config.dataApiUrl || new URL(config.dataApiUrl).protocol !== 'https:') throw new BankHttpError('Authentication is not configured on the server.', 503)
  const workspaceId = assertUUID(workspace, 'Workspace')
  // Neon validates the JWT and enforces read-self RLS on memberships.
  const read = async (table: string, query: Record<string, string>) => {
    const url = new URL(`${config.dataApiUrl!.replace(/\/$/, '')}/${table}`)
    url.search = new URLSearchParams(query).toString()
    const result = await fetch(url, { headers: { Authorization: authorization, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
    if (!result.ok) throw new BankHttpError('Your session or workspace access could not be verified.', result.status === 401 ? 401 : 403)
    return await result.json() as Record<string, unknown>[]
  }
  const members = await read('workspace_members', { select: 'workspace_id', workspace_id: `eq.${workspaceId}`, limit: '1' })
  if (!members.length) throw new BankHttpError('You do not have access to this workspace.', 403)
  const accountId = account == null ? null : assertUUID(account, 'Account')
  let providerAccountId: string | null = null
  if (accountId) {
    const accounts = await read('accounts', { select: 'id,provider_account_id', id: `eq.${accountId}`, workspace_id: `eq.${workspaceId}`, limit: '1' })
    if (!accounts.length) throw new BankHttpError('This account is not available in your workspace.', 403)
    providerAccountId = accounts[0].provider_account_id ? assertUUID(accounts[0].provider_account_id, 'Linked bank account') : null
  }
  return { workspaceId, accountId, providerAccountId, read }
}

// The provider stores this signed reference, so a client cannot claim another
// workspace's requisition by submitting its UUID to the public API.
export function bankReference(workspaceId: string, accountId: string, key: string, nonce: string = randomUUID()): string {
  const message = `next-expense:${workspaceId}:${accountId}:${nonce}`
  return `${message}:${createHmac('sha256', key).update(message).digest('hex')}`
}
export function verifyBankReference(reference: unknown, workspaceId: string, accountId: string, key: string): boolean {
  if (typeof reference !== 'string') return false
  const parts = reference.split(':')
  if (parts.length !== 5 || parts[0] !== 'next-expense' || parts[1] !== workspaceId || parts[2] !== accountId) return false
  const expected = Buffer.from(bankReference(workspaceId, accountId, key, parts[3]))
  const received = Buffer.from(reference)
  return expected.length === received.length && timingSafeEqual(expected, received)
}
