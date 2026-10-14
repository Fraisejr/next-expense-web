import { Pool, neonConfig } from '@neondatabase/serverless'
import type { Config } from './config.ts'

export type Row = Record<string, unknown>
export interface Store {
  query(text: string, values?: unknown[]): Promise<Row[]>
}
let sharedPool: { url: string; pool: Pool } | undefined
export function database(config: Config): Store {
  neonConfig.webSocketConstructor = WebSocket
  if (!sharedPool || sharedPool.url !== config.databaseUrl) {
    sharedPool = { url: config.databaseUrl, pool: new Pool({ connectionString: config.databaseUrl, max: 3, idleTimeoutMillis: 1000 }) }
  }
  const pool = sharedPool.pool
  return { query: async (text, values = []) => (await pool.query(text, values)).rows }
}
// Memberships are read-self under Neon RLS. Never trust a decoded JWT or a
// browser-supplied user ID. The Data API validates the token before identifying it.
export async function identity(request: Request, config: Config) {
  const authorization = request.headers.get('authorization')
  if (!authorization || !/^Bearer [^\s]+$/i.test(authorization) || authorization.length > 16384) throw new Error('unauthorized')
  const url = new URL(`${config.dataApiUrl.replace(/\/$/, '')}/workspace_members`)
  url.searchParams.set('select', 'workspace_id,user_id,role')
  const response = await fetch(url, { headers: { Authorization: authorization }, signal: AbortSignal.timeout(15000), redirect: 'error' })
  if (!response.ok) throw new Error('unauthorized')
  const rows = await response.json() as { workspace_id: string; user_id: string; role: string }[]
  if (!Array.isArray(rows) || !rows.length || !rows[0].user_id || rows.some(row => row.user_id !== rows[0].user_id)) throw new Error('unauthorized')
  const workspaceUrl = new URL(`${config.dataApiUrl.replace(/\/$/, '')}/workspaces`)
  workspaceUrl.searchParams.set('select', 'id,name')
  const namesResponse = await fetch(workspaceUrl, { headers: { Authorization: authorization }, signal: AbortSignal.timeout(15000), redirect: 'error' })
  if (!namesResponse.ok) throw new Error('unauthorized')
  const names = await namesResponse.json() as { id: string; name: string }[]
  return { userId: rows[0].user_id, memberships: rows.map(row => ({ ...row, name: names.find(item => item.id === row.workspace_id)?.name || 'Workspace' })) }
}
