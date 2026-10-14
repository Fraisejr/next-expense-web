import { useEffect, useState } from 'react'
import { neon } from './neon'

type Details = {
  client_name: string; redirect_uri: string; scope: string
  memberships: { workspace_id: string; name: string; role: string }[]
  connections: { id: string; client_name: string; workspace_id: string; scope: string }[]
}
export function McpConsent() {
  const [details, setDetails] = useState<Details>()
  const [workspace, setWorkspace] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const request = new URLSearchParams(window.location.search).get('request') || ''
  async function call(method: string, body?: unknown) {
    const token = (await neon.auth.getSession()).data?.session.token
    if (!token) throw new Error('Sign in again to connect your account.')
    const response = await fetch(`/api/mcp-oauth/consent${request ? `?request=${encodeURIComponent(request)}` : ''}`, { method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    if (!response.ok) throw new Error('This connection request expired or is unavailable. Start again from ChatGPT or Codex.')
    return response.json()
  }
  useEffect(() => {
    let active = true
    void call('GET').then(value => { if (active) { setDetails(value); setWorkspace(value.memberships[0]?.workspace_id || '') } }).catch(caught => { if (active) setError(caught.message) })
    return () => { active = false }
    // The request ID stays fixed throughout this consent page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request])
  async function decide(decision: 'allow' | 'deny') {
    setPending(true); setError('')
    try {
      const result = await call('POST', { request, workspace_id: workspace, decision })
      window.location.assign(result.redirect)
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Connection failed.'); setPending(false) }
  }
  async function revoke(id: string) {
    setPending(true); setError('')
    try { await call('POST', { revoke_id: id }); setDetails(current => current ? { ...current, connections: current.connections.filter(item => item.id !== id) } : current) }
    catch { setError('Could not disconnect. Please try again.') }
    finally { setPending(false) }
  }
  return <main className="auth-page"><section className="auth-card">
    <h1>{request ? 'Connect to Next Expense' : 'Connected apps'}</h1>
    {details ? <>
      {request && <>
      <p><strong>{details.client_name}</strong> requests access to your expenses.</p>
      <p>{details.scope.includes('expenses:write') ? 'Allow this connection to read transactions, accounts, categories and budgets, record expenses and income, edit transaction details, create payees, and set budgets.' : 'Allow this connection to read transactions, accounts, categories, payees and budgets.'}</p>
      <p>Returns to: {new URL(details.redirect_uri).origin}</p>
      <label>Workspace<select value={workspace} onChange={event => setWorkspace(event.target.value)}>{details.memberships.map(member => <option key={member.workspace_id} value={member.workspace_id} disabled={member.role === 'viewer' && details.scope.includes('expenses:write')}>{member.name} ({member.role})</option>)}</select></label>
      <div className="form"><button className="primary-button" disabled={pending || !workspace} onClick={() => void decide('allow')}>Allow access</button><button disabled={pending} onClick={() => void decide('deny')}>Deny</button></div>
      </>}
      {!request && details.connections.length === 0 && <p>No connected apps.</p>}
      {details.connections.length > 0 && <><h2>Existing connections</h2>{details.connections.map(connection => <p key={connection.id}>{connection.client_name} <button disabled={pending} onClick={() => void revoke(connection.id)}>Disconnect</button></p>)}</>}
    </> : !error && <p role="status">Loading connection request…</p>}
    <p><a href="/">Return to Next Expense</a></p>
    {error && <p role="alert">{error}</p>}
  </section></main>
}
