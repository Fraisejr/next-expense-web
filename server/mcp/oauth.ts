import { randomUUID } from 'node:crypto'
import { challenge, hash, json, parseScopes, secret, validRedirect, scopes, type Config } from './config.ts'
import { identity, type Store, type Row } from './store.ts'

async function body(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get('content-length') || 0) > 16384) throw new Error('invalid_request')
  const raw = await request.text()
  if (raw.length > 16384) throw new Error('invalid_request')
  if (request.headers.get('content-type')?.includes('application/json')) return JSON.parse(raw)
  return Object.fromEntries(new URLSearchParams(raw))
}
const string = (row: Row, key: string) => typeof row[key] === 'string' ? row[key] as string : ''
export async function oauth(request: Request, config: Config, store: Store) {
  const url = new URL(request.url)
  // Vercel may present the rewritten URL. Preserve routing explicitly.
  const rewrittenRoute = url.searchParams.get('mcp_route')
  const path = rewrittenRoute === 'resource' ? '/.well-known/oauth-protected-resource'
    : rewrittenRoute === 'metadata' ? '/.well-known/oauth-authorization-server'
    : rewrittenRoute ? `/api/mcp-oauth/${rewrittenRoute}` : url.pathname
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } })
  const send = (value: unknown, status = 200) => json(value, status, { 'Access-Control-Allow-Origin': '*' })
  try {
    if (request.method === 'GET' && path.startsWith('/.well-known/oauth-protected-resource')) return send({ resource: config.resource, authorization_servers: [config.origin], scopes_supported: scopes, bearer_methods_supported: ['header'] })
    if (request.method === 'GET' && path === '/.well-known/oauth-authorization-server') return send({ issuer: config.origin, authorization_endpoint: `${config.origin}/api/mcp-oauth/authorize`, token_endpoint: `${config.origin}/api/mcp-oauth/token`, registration_endpoint: `${config.origin}/api/mcp-oauth/register`, revocation_endpoint: `${config.origin}/api/mcp-oauth/revoke`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], scopes_supported: scopes })
    if (path === '/api/mcp-oauth/register' && request.method === 'POST') {
      const input = await body(request)
      const redirects = input.redirect_uris
      if (!Array.isArray(redirects) || !redirects.length || redirects.length > 5 || !redirects.every(uri => typeof uri === 'string' && uri.length < 2048 && validRedirect(uri)) || (input.token_endpoint_auth_method && input.token_endpoint_auth_method !== 'none')) throw new Error('invalid_client_metadata')
      const clientId = randomUUID()
      const value = { client_id: clientId, client_name: String(input.client_name || 'MCP client').slice(0, 100), redirect_uris: redirects, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }
      await store.query('insert into expense_mcp.records (id, kind, value, expires_at) values ($1, $2, $3::jsonb, now() + interval \'365 days\')', [clientId, 'client', JSON.stringify(value)])
      return send(value, 201)
    }
    if (path === '/api/mcp-oauth/authorize' && request.method === 'GET') {
      const input = Object.fromEntries(url.searchParams)
      const [client] = await store.query("select value from expense_mcp.records where id=$1 and kind='client' and expires_at>now()", [input.client_id || ''])
      if (!client || !(client.value as { redirect_uris: string[] }).redirect_uris.includes(input.redirect_uri) || input.response_type !== 'code' || input.resource !== config.resource || input.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(input.code_challenge || '') || !input.state || input.state.length > 2048) throw new Error('invalid_request')
      const scope = parseScopes(input.scope || 'expenses:read expenses:write')
      const id = secret()
      await store.query('insert into expense_mcp.records (id,kind,value,expires_at) values ($1,\'request\',$2::jsonb,now()+interval \'10 minutes\')', [id, JSON.stringify({ ...input, scope, client_name: (client.value as Row).client_name })])
      return Response.redirect(`${config.origin}/oauth/consent?request=${encodeURIComponent(id)}`, 302)
    }
    if (path === '/api/mcp-oauth/consent' && ['GET', 'POST'].includes(request.method)) {
      if (request.method === 'POST' && request.headers.get('origin') !== config.origin) return send({ error: 'invalid_request' }, 403)
      const user = await identity(request, config)
      if (request.method === 'GET') {
        const [pending] = await store.query("select value from expense_mcp.records where id=$1 and kind='request' and expires_at>now()", [url.searchParams.get('request') || ''])
        if (!pending && url.searchParams.has('request')) throw new Error('invalid_request')
        const value = (pending?.value || {}) as Row
        const [connections] = await store.query('select coalesce(jsonb_agg(jsonb_build_object(\'id\',id,\'client_name\',client_name,\'workspace_id\',workspace_id,\'scope\',scope)),\'[]\'::jsonb) as items from expense_mcp.grants where user_id=$1 and revoked_at is null and refresh_expires_at>now()', [user.userId])
        return send({ client_name: value.client_name, redirect_uri: value.redirect_uri, scope: value.scope, memberships: user.memberships, connections: connections.items })
      }
      const input = await body(request)
      if (input.revoke_id) {
        await store.query('update expense_mcp.grants set revoked_at=now() where id=$1::uuid and user_id=$2', [input.revoke_id, user.userId])
        return send({ revoked: true })
      }
      const workspace = user.memberships.find(member => member.workspace_id === input.workspace_id)
      if (input.decision !== 'deny' && (!workspace || !['owner', 'member', 'viewer'].includes(workspace.role))) throw new Error('access_denied')
      const code = secret()
      // Consume consent and persist a hashed one-use code atomically.
      const [pending] = await store.query("with consumed as (delete from expense_mcp.records where id=$1 and kind='request' and expires_at>now() returning value), saved as (insert into expense_mcp.records(id,kind,value,expires_at) select $2,'code',value || jsonb_build_object('user_id',$3::text,'workspace_id',$4::text),now()+interval '2 minutes' from consumed where $5::boolean returning id) select value from consumed", [input.request, hash(code), user.userId, workspace?.workspace_id || '', input.decision === 'allow'])
      if (!pending || !['allow', 'deny'].includes(String(input.decision))) throw new Error('invalid_request')
      const value = pending.value as Row
      if (input.decision === 'allow' && workspace?.role === 'viewer' && String(value.scope).includes('expenses:write')) {
        await store.query('delete from expense_mcp.records where id=$1', [hash(code)])
        throw new Error('access_denied')
      }
      const redirect = new URL(String(value.redirect_uri))
      redirect.searchParams.set('state', String(value.state))
      redirect.searchParams.set(input.decision === 'deny' ? 'error' : 'code', input.decision === 'deny' ? 'access_denied' : code)
      return send({ redirect: redirect.href })
    }
    if (path === '/api/mcp-oauth/token' && request.method === 'POST') {
      const input = await body(request)
      if (input.resource !== config.resource) throw new Error('invalid_target')
      const access = secret(), refresh = secret()
      if (input.grant_type === 'authorization_code') {
        const verifier = string(input, 'code_verifier')
        if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new Error('invalid_grant')
        const [row] = await store.query("with code as (delete from expense_mcp.records where id=$1 and kind='code' and expires_at>now() and value->>'client_id'=$2 and value->>'redirect_uri'=$3 and value->>'resource'=$4 and value->>'code_challenge'=$5 returning value) insert into expense_mcp.grants (id,user_id,workspace_id,client_id,client_name,resource,scope,access_hash,refresh_hash,access_expires_at,refresh_expires_at) select $6::uuid,value->>'user_id',(value->>'workspace_id')::uuid,value->>'client_id',value->>'client_name',value->>'resource',value->>'scope',$7,$8,now()+interval '1 hour',now()+interval '30 days' from code returning scope", [hash(string(input, 'code')), input.client_id, input.redirect_uri, input.resource, challenge(verifier), randomUUID(), hash(access), hash(refresh)])
        if (!row) throw new Error('invalid_grant')
        return send({ access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600, scope: row.scope })
      }
      if (input.grant_type === 'refresh_token') {
        const [row] = await store.query("update expense_mcp.grants g set access_hash=$1,refresh_hash=$2,access_expires_at=now()+interval '1 hour' where refresh_hash=$3 and client_id=$4 and resource=$5 and revoked_at is null and refresh_expires_at>now() and ($6::text is null or scope=$6) and exists(select 1 from expense_mcp.active_memberships m where m.user_id=g.user_id and m.workspace_id=g.workspace_id and (position('expenses:write' in g.scope)=0 or m.role in ('owner','member'))) returning scope", [hash(access), hash(refresh), hash(string(input, 'refresh_token')), input.client_id, input.resource, input.scope || null])
        if (!row) throw new Error('invalid_grant')
        return send({ access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600, scope: row.scope })
      }
      throw new Error('unsupported_grant_type')
    }
    if (path === '/api/mcp-oauth/revoke' && request.method === 'POST') {
      const input = await body(request)
      await store.query('update expense_mcp.grants set revoked_at=now() where client_id=$1 and (access_hash=$2 or refresh_hash=$2)', [input.client_id, hash(string(input, 'token'))])
      return send({})
    }
    return send({ error: 'not_found' }, 404)
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (message === 'unauthorized') return send({ error: 'unauthorized' }, 401)
    return send({ error: ['invalid_request', 'invalid_scope', 'invalid_client_metadata', 'invalid_target', 'invalid_grant', 'unsupported_grant_type', 'access_denied'].includes(message) ? message : 'server_error' }, message === 'access_denied' ? 403 : message.includes('invalid') || message === 'unsupported_grant_type' ? 400 : 503)
  }
}
