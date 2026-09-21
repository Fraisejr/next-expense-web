const verifierParameter = 'neon_auth_session_verifier'

type CallbackAuth = {
  getSession: () => Promise<{ data: unknown; error: unknown }>
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message
  return ''
}

export function isExpiredJwtError(error: unknown) {
  const message = errorMessage(error).toLowerCase()
  return message.includes('jwt token has expired')
    || message.includes('jwt expired')
    || (message.includes('token') && message.includes('expired'))
}

// A request started before a background tab was suspended can finish after its
// JWT expires. Refresh the cookie-backed session and replay that request once.
export async function retryAfterExpiredSession<T>(operation: () => Promise<T>, auth: CallbackAuth): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (!isExpiredJwtError(error)) throw error

    const refreshed = await auth.getSession()
    if (refreshed.error) throw refreshed.error
    if (!refreshed.data) throw error
    return operation()
  }
}

// Finish the one-time exchange before React session hooks or Data API reads
// can start another get-session request with the same verifier.
export async function completeAuthCallback(auth: CallbackAuth, browser: Pick<Window, 'location' | 'history'>) {
  if (!new URLSearchParams(browser.location.search).has(verifierParameter)) return
  const result = await auth.getSession()
  if (result.error) throw result.error
  if (!result.data) throw new Error('Sign-in did not establish a session.')
  clearAuthCallback(browser)
}

export function clearAuthCallback(browser: Pick<Window, 'location' | 'history'>) {
  const url = new URL(browser.location.href)
  url.searchParams.delete(verifierParameter)
  browser.history.replaceState(browser.history.state, '', url.href)
}
