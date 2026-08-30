const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

export async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(String(value))));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function randomToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function encryptionKey(secret) {
  if (!secret) throw Object.assign(new Error('TOKEN_ENCRYPTION_KEY is required'), { status: 503 });
  const raw = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function sealSecret(value, secret) {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await encryptionKey(secret),
    encoder.encode(String(value))
  ));
  return `enc:v1:${bytesToBase64Url(iv)}:${bytesToBase64Url(encrypted)}`;
}

export async function openSecret(value, secret) {
  const stored = String(value || '');
  if (!stored.startsWith('enc:v1:')) return stored; // backwards-compatible Plaid rows
  const [, , ivPart, ciphertextPart] = stored.split(':');
  if (!ivPart || !ciphertextPart) throw new Error('invalid encrypted secret');
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64UrlToBytes(ivPart) },
      await encryptionKey(secret),
      base64UrlToBytes(ciphertextPart)
    );
    return decoder.decode(plain);
  } catch {
    throw Object.assign(new Error('Unable to decrypt provider token; check TOKEN_ENCRYPTION_KEY'), {
      status: 503,
    });
  }
}
