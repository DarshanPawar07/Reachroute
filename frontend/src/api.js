export const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:4000';
const BASE = API_BASE;

/**
 * Small fetch wrapper.
 *   api('/api/dashboard')
 *   api('/api/auth/login', { method: 'POST', body: { email, password } })
 *   api('/api/email/campaigns', { method: 'POST', form: formData })
 * Throws an Error with the server's message on any non-2xx response.
 */
export async function api(path, { method = 'GET', body, form } = {}) {
  const headers = {};
  const token = localStorage.getItem('token');
  if (token) headers.Authorization = `Bearer ${token}`;

  let payload;
  if (form) {
    payload = form; // the browser sets the multipart boundary itself
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(BASE + path, { method, headers, body: payload });
  } catch {
    throw new Error('Cannot reach the server. Is the backend running?');
  }

  const data = await res.json().catch(() => ({}));

  if (res.status === 401 && token) {
    localStorage.removeItem('token');
    localStorage.removeItem('email');
    window.location.href = '/login';
  }
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
    throw new Error('Cannot reach the server. Is the backend running?');
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
