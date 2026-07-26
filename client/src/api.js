// API base: '' for local dev (Vite proxies /api → :8080 Express, no auth).
// For the GitHub Pages build, set VITE_API_BASE to the Cloudflare worker URL
// (e.g. https://credit-tracker-api.<account>.workers.dev) — cross-origin, bearer-token auth.
const API_BASE = import.meta.env.VITE_API_BASE || '';

const TOKEN_KEY = 'ct_token';
export const session = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

let onUnauthorized = null;
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

async function req(method, path, body) {
  const token = session.get();
  const res = await fetch(API_BASE + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    const err = new Error(data.error || `${method} ${path} failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  get: (p) => req('GET', p),
  post: (p, b) => req('POST', p, b),
  del: (p) => req('DELETE', p),
};

export function money(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0);
}
