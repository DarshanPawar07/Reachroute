export const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:4000';
const BASE = API_BASE;

// The free hosting puts the server to sleep when nobody uses it, and waking it can take up to a minute.
const REQUEST_TIMEOUT_MS = 70_000;

/** The error for "the server did not answer", worded so the person knows it is not their email or password. */
export function serverDown(kind, status) {
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const text = offline
    ? 'You seem to be offline. Check your internet connection and try again.'
    : kind === 'timeout'
      ? 'The server took too long to answer. It may be starting up after a quiet period. Wait a few seconds and try again.'
      : kind === 'gateway'
        ? `The server is not working right now (error ${status}). It may be starting up or being updated. Try again in a minute.`
        : 'We cannot reach the server right now. If your internet is fine, the server is down or still starting up (this can take up to a minute). Try again shortly.';
  return Object.assign(new Error(text), { code: 'server_down', status: status || 0 });
}

/**
 * Small fetch wrapper.
 *   api('/api/dashboard')
 *   api('/api/auth/login', { method: 'POST', body: { email, password } })
 *   api('/api/email/campaigns', { method: 'POST', form: formData })
 * Throws an Error with the server's message on any non-2xx response.
 */
export async function api(path, { method = 'GET', body, form, token: explicitToken } = {}) {
  const headers = {};
  const token = explicitToken || localStorage.getItem('token');
  if (token) headers.Authorization = `Bearer ${token}`;

  let payload;
  if (form) {
    payload = form; // the browser sets the multipart boundary itself
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let res;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    res = await fetch(BASE + path, { method, headers, body: payload, signal: controller.signal });
  } catch (err) {
    throw serverDown(err.name === 'AbortError' ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }

  const data = await res.json().catch(() => ({}));

  // 401 on a request that carried the saved login: the login expired. (An explicit token is the sign-up code step: handled by its page.)
  if (res.status === 401 && token && !explicitToken) {
    localStorage.removeItem('token');
    localStorage.removeItem('email');
    window.location.href = '/login';
  }
  // A gateway answer (not from our app) means the server is down or still starting.
  if (!data.error && [502, 503, 504].includes(res.status)) throw serverDown('gateway', res.status);
  if (!res.ok) {
    // An unexpected server error carries a reference: it finds the exact line in the backend log.
    const ref = data.requestId ? ` (reference ${String(data.requestId).slice(0, 8)})` : '';
    const err = new Error((data.error || `Request failed (${res.status})`) + ref);
    err.status = res.status;
    err.data = data;
    err.code = data.code; // for example "terms_required" or "sender_not_verified"
    throw err;
  }
  return data;
}

/** Download a file the server makes (it needs the login, so a plain link cannot be used). Saves it with the name the server gives. */
export async function downloadFile(path, fallbackName = 'download') {
  const token = localStorage.getItem('token');
  let res;
  try {
    res = await fetch(BASE + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  } catch {
    throw serverDown('network');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Download failed (${res.status})`);
  }
  const named = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = named ? named[1] : fallbackName;
  a.click();
  URL.revokeObjectURL(url);
}
