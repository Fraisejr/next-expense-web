import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { config as loadConfig, hash, json, type Config } from './config.ts'
import { database, type Store } from './store.ts'
import { server } from './tools.ts'
import { oauth } from './oauth.ts'

export async function handle(request: Request, config: Config | null = loadConfig(), suppliedStore?: Store) {
  if (!config) return json({ error: 'MCP is not configured.' }, 503)
  // Discovery and unauthenticated requests need no database pool; pool
  // server credentials only, never user tokens.
  const store = suppliedStore || { query: async (sql: string, args?: unknown[]) => database(config).query(sql, args) }
  if (new URL(request.url).pathname !== '/api/mcp') return oauth(request, config, store)
  const origin = request.headers.get('origin')
  if (origin && origin !== config.origin) return json({ error: 'Origin is not allowed.' }, 403)
  if (!['POST', 'GET', 'DELETE'].includes(request.method)) return json({ error: 'Method not allowed.' }, 405, { Allow: 'POST, GET, DELETE' })
  const unauthorized = () => json({ error: 'Connect your Next Expense account.' }, 401, { 'WWW-Authenticate': `Bearer resource_metadata="${config.origin}/.well-known/oauth-protected-resource/api/mcp"` })
  const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i)?.[1]
  if (!token) return unauthorized()
  const accessHash = hash(token)
  try {
    const [grant] = await store.query("select g.scope from expense_mcp.grants g join expense_mcp.active_memberships m on m.user_id=g.user_id and m.workspace_id=g.workspace_id where access_hash=$1 and resource=$2 and revoked_at is null and access_expires_at>now() and (position('expenses:write' in g.scope)=0 or m.role in ('owner','member'))", [accessHash, config.resource])
    if (!grant) return unauthorized()
    const mcp = server(store, accessHash, String(grant.scope))
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await mcp.connect(transport)
    try {
      const response = await transport.handleRequest(request)
      response.headers.set('Cache-Control', 'no-store')
      return response
    } finally { await mcp.close() }
  } catch { return json({ error: 'MCP is temporarily unavailable.' }, 503) }
}
