import { createHash, randomBytes } from 'node:crypto'

export const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export const secret = () => randomBytes(32).toString('base64url')
export const challenge = (value: string) => createHash('sha256').update(value).digest('base64url')
export const scopes = ['expenses:read', 'expenses:write']
export function config(env = process.env) {
  const origin = env.APP_URL
  if (!origin || !env.MCP_DATABASE_URL || !env.VITE_NEON_DATA_API_URL) return null
  const url = new URL(origin)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) return null
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null
  return { origin: url.origin, resource: `${url.origin}/api/mcp`, databaseUrl: env.MCP_DATABASE_URL, dataApiUrl: env.VITE_NEON_DATA_API_URL }
}
export type Config = NonNullable<ReturnType<typeof config>>
export function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } })
}
export function validRedirect(value: string) {
  try {
    const url = new URL(value)
    return !url.username && !url.password && !url.hash && (url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  } catch { return false }
}
export function parseScopes(value: string) {
  const selected = [...new Set(value.split(' ').filter(Boolean))]
  if (!selected.length || selected.some(scope => !scopes.includes(scope)) || !selected.includes('expenses:read')) throw new Error('invalid_scope')
  return selected.join(' ')
}
