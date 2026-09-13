// No arbitrary redirect target, storage, analytics, or network requests.
export function appCallback(search) {
  const params = new URLSearchParams(search);
  const states = params.getAll('state');
  if (states.length !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(states[0])) return null;
  const result = new URL('com.fraisejr.nextexpense://auth/callback');
  result.searchParams.set('state', states[0]);
  if (params.has('error')) {
    result.searchParams.set('error', 'sign_in_failed');
    return result.href;
  }
  const values = params.getAll('neon_auth_session_verifier');
  if (values.length !== 1 || !values[0] || values[0].length > 8192 || /[\x00-\x20\x7f]/.test(values[0])) return null;
  result.searchParams.set('neon_auth_session_verifier', values[0]);
  return result.href;
}

if (typeof document !== 'undefined') {
  const callback = appCallback(location.search);
  history.replaceState(null, '', location.pathname);
  if (callback) {
    document.getElementById('title').textContent = 'Opening Next Expense…';
    document.getElementById('message').textContent = 'If the app does not open automatically, tap below.';
    const link = document.getElementById('return');
    link.href = callback;
    link.hidden = false;
    location.replace(callback);
  }
}
