import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedEmails, verifyGoogleCredential } from '../worker/src/auth.js';

test('Google allowlist merges the primary and additional secrets', () => {
  assert.deepEqual(allowedEmails({
    ALLOWED_EMAIL: 'Owner@Example.com',
    ADDITIONAL_ALLOWED_EMAILS: ' collaborator@example.com, second@example.com ',
  }), [
    'owner@example.com',
    'collaborator@example.com',
    'second@example.com',
  ]);
});
test('Google sign-in accepts an account from the additional allowlist', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    aud: 'google-client-id',
    email_verified: 'true',
    email: 'Collaborator@Example.com',
  });
  try {
    const result = await verifyGoogleCredential({
      GOOGLE_CLIENT_ID: 'google-client-id',
      ALLOWED_EMAIL: 'owner@example.com',
      ADDITIONAL_ALLOWED_EMAILS: 'collaborator@example.com',
    }, 'credential');
    assert.deepEqual(result, { ok: true, email: 'Collaborator@Example.com' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
