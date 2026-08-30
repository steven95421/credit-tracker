const encoder = new TextEncoder();

function decodeBytes(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('empty encoded value');

  const pem = text.match(/-----BEGIN [^-]+-----([\s\S]+?)-----END [^-]+-----/);
  const body = (pem ? pem[1] : text).replace(/\s+/g, '');
  const hex = body.replace(/^0x/, '');
  if (/^[0-9a-f]+$/i.test(hex) && hex.length % 2 === 0) {
    return Uint8Array.from(hex.match(/.{2}/g), (pair) => Number.parseInt(pair, 16));
  }

  const normalized = body.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
  } catch {
    throw new Error('unsupported Teller key or signature encoding');
  }
}

async function importEd25519PublicKey(value) {
  const bytes = decodeBytes(value);
  const format = bytes.length === 32 ? 'raw' : 'spki';
  try {
    return await crypto.subtle.importKey(format, bytes, { name: 'Ed25519' }, false, ['verify']);
  } catch {
    throw new Error('TELLER_TOKEN_SIGNING_KEY must be an Ed25519 raw or SPKI public key');
  }
}

export function tellerSignedMessage(nonce, enrollment, environment) {
  const accessToken = enrollment?.accessToken;
  const userId = enrollment?.user?.id;
  const enrollmentId = enrollment?.enrollment?.id;
  if (!nonce || !accessToken || !userId || !enrollmentId || !environment) {
    throw new Error('incomplete Teller enrollment payload');
  }
  return `${nonce}.${accessToken}.${userId}.${enrollmentId}.${environment}`;
}

export async function verifyTellerEnrollment(signingKey, nonce, enrollment, environment) {
  const signatures = Array.isArray(enrollment?.signatures) ? enrollment.signatures : [];
  if (signatures.length === 0) return false;
  const key = await importEd25519PublicKey(signingKey);
  const message = encoder.encode(tellerSignedMessage(nonce, enrollment, environment));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', message));

  for (const encodedSignature of signatures) {
    let signature;
    try {
      signature = decodeBytes(encodedSignature);
    } catch {
      continue;
    }
    // Teller documents Ed25519 over the SHA-256 digest of the dot-concatenated
    // fields. Stay fail-closed on that exact format.
    if (await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, digest)) return true;
  }
  return false;
}
