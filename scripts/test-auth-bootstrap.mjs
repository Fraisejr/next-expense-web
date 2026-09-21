import assert from 'node:assert/strict'
import { completeAuthCallback, isExpiredJwtError, retryAfterExpiredSession } from '../src/auth-bootstrap.ts'

const browser = {
  location: new URL('https://expense.example/?month=2026-09&neon_auth_session_verifier=one-use#ledger'),
  history: { state: { retained: true }, replaceState(state, _, href) { this.state = state; browser.location = new URL(href) } },
  addEventListener() {}, removeEventListener() {},
}
globalThis.window = browser
globalThis.document = { addEventListener() {}, removeEventListener() {} }
globalThis.history = browser.history
const { createClient } = await import('@neondatabase/neon-js')
const { BetterAuthReactAdapter } = await import('@neondatabase/neon-js/auth/react/adapters')
let exchanges = 0
let reads = 0
let release
const pendingExchange = new Promise(resolve => { release = resolve })
const token = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now()/1000)+3600 })).toString('base64url')}.test`
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input))
  if (url.hostname === 'auth.example') {
    if (url.searchParams.has('neon_auth_session_verifier')) {
      exchanges++
      if (exchanges > 1) return Response.json({ code: 'validation_failed' }, { status: 400 })
      await pendingExchange
    }
    return Response.json({ session: { id: 'session', token, expiresAt: new Date(Date.now()+3600000).toISOString() }, user: { id: 'user', email: 'test@example.com' } }, { headers: { 'set-auth-jwt': token } })
  }
  assert.equal(url.hostname, 'data.example')
  assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`)
  reads++
  return Response.json([])
}
const client = createClient({auth:{url:'https://auth.example/auth',adapter:BetterAuthReactAdapter()},dataApi:{url:'https://data.example/rest/v1'}})
const started = completeAuthCallback(client.auth, browser).then(async () => {
  const results = await Promise.all(Array.from({length:15}, () => client.from('accounts').select('id')))
  for (const result of results) assert.equal(result.error, null)
})
await new Promise(resolve => setTimeout(resolve, 20))
assert.equal(reads, 0, 'Workspace reads must wait for the callback exchange')
release()
await started
assert.equal(exchanges, 1, 'The one-time verifier must never be replayed')
assert.equal(reads, 15)
assert.equal(browser.location.href, 'https://expense.example/?month=2026-09#ledger')
assert.deepEqual(browser.history.state, {retained:true})
let calls = 0
await completeAuthCallback({getSession:async()=>{ calls++; throw Error('unexpected') }}, browser)
assert.equal(calls,0,'Normal visits need no extra bootstrap request')
browser.location = new URL('https://expense.example/?neon_auth_session_verifier=invalid')
await assert.rejects(completeAuthCallback({getSession:async()=>({data:null,error:Error('Rejected')})}, browser), /Rejected/)
await assert.rejects(completeAuthCallback({getSession:async()=>({data:null,error:null})}, browser), /did not establish/)

assert.equal(isExpiredJwtError(new Error('JWT token has expired (exp=1789939827)')), true)
assert.equal(isExpiredJwtError({ message: 'Token expired while the tab was asleep' }), true)
assert.equal(isExpiredJwtError(new Error('Network request failed')), false)

let attempts = 0
let refreshes = 0
const recovered = await retryAfterExpiredSession(async () => {
  attempts++
  if (attempts === 1) throw new Error('JWT token has expired (exp=1789939827)')
  return 'workspace'
}, { getSession: async () => { refreshes++; return { data: { session: true }, error: null } } })
assert.equal(recovered, 'workspace')
assert.equal(attempts, 2, 'An expired request should be replayed once')
assert.equal(refreshes, 1, 'The session should refresh before replaying the request')

let unrelatedAttempts = 0
await assert.rejects(retryAfterExpiredSession(async () => {
  unrelatedAttempts++
  throw new Error('Database unavailable')
}, { getSession: async () => { throw new Error('unexpected refresh') } }), /Database unavailable/)
assert.equal(unrelatedAttempts, 1, 'Unrelated failures must not be retried')

console.log('Auth bootstrap passed: callback exchange and expired background sessions recover safely')
