// Google Sign-In verification + stateless bearer sessions.
// No passwords anywhere: identity = a Google ID token verified against Google,
// gated by an email allowlist; sessions = HMAC-signed expiring tokens.

const enc = new TextEncoder();

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function b64urlToBytes(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function hmacKey(env, usages) {
  return crypto.subtle.importKey('raw', enc.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}

export const devMode = (env) => env.DEV_MODE === '1';

/** token = b64url(`${expiryMs}.${email}`) + '.' + b64url(HMAC) */
export async function makeSession(env, email) {
  if (!env.SESSION_SECRET) {
    throw Object.assign(new Error('SESSION_SECRET is not set — run `npx wrangler secret put SESSION_SECRET`.'), { status: 503 });
  }
  const ttlDays = Number(env.SESSION_TTL_DAYS) || 30;
  const payload = `${Date.now() + ttlDays * 86400000}.${email}`;
  const key = await hmacKey(env, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return `${b64url(enc.encode(payload))}.${b64url(sig)}`;
}

export async function verifySession(env, token) {
  if (!env.SESSION_SECRET || !token) return false;
  const parts = String(token).split('.');
  if (parts.length !== 2) return false;
  let payloadBytes, sigBytes;
  try {
    payloadBytes = b64urlToBytes(parts[0]);
    sigBytes = b64urlToBytes(parts[1]);
  } catch {
    return false;
  }
  const key = await hmacKey(env, ['verify']);
  if (!(await crypto.subtle.verify('HMAC', key, sigBytes, payloadBytes))) return false;
  const exp = Number(new TextDecoder().decode(payloadBytes).split('.')[0]);
  return Number.isFinite(exp) && Date.now() < exp;
}

/** Validates a Google ID token (from Google Identity Services) and applies the email allowlist. */
export async function verifyGoogleCredential(env, credential) {
  if (!env.GOOGLE_CLIENT_ID) return { ok: false, error: 'GOOGLE_CLIENT_ID is not configured on the worker' };
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
  if (!r.ok) return { ok: false, error: 'Google rejected the sign-in token' };
  const info = await r.json();
  if (info.aud !== env.GOOGLE_CLIENT_ID) return { ok: false, error: 'Sign-in token belongs to a different OAuth client' };
  if (String(info.email_verified) !== 'true') return { ok: false, error: 'Google account email is not verified' };
  const allowed = (env.ALLOWED_EMAIL || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  const email = String(info.email || '').toLowerCase();
  if (!allowed.includes(email)) return { ok: false, error: `${info.email} is not on the allowlist` };
  return { ok: true, email: info.email };
}

/** Bearer-token check for API requests. */
export async function isAuthed(env, req) {
  if (devMode(env)) return true;
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('Authorization') || '');
  return m ? verifySession(env, m[1]) : false;
}
