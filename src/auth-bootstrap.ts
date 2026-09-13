const verifierParameter = 'neon_auth_session_verifier'

type CallbackAuth = {
  getSession: () => Promise<{ data: unknown; error: unknown }>
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
