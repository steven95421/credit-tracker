import test from 'node:test';
import assert from 'node:assert/strict';
import { tellerSignedMessage, verifyTellerEnrollment } from '../worker/src/teller-crypto.js';
import { openSecret, sealSecret } from '../worker/src/secrets.js';

const base64 = (bytes) => Buffer.from(bytes).toString('base64');

test('Teller enrollment signature binds nonce, token, user, enrollment, and environment', async () => {
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const enrollment = {
    accessToken: 'token_test',
    user: { id: 'usr_test' },
    enrollment: { id: 'enr_test', institution: { name: 'Test Bank' } },
    signatures: [],
  };
  const documentedMessage = 'nonce_a.token_test.usr_test.enr_test.development';
  assert.equal(tellerSignedMessage('nonce_a', enrollment, 'development'), documentedMessage);
  const message = new TextEncoder().encode(documentedMessage);
  const digest = await crypto.subtle.digest('SHA-256', message);
  enrollment.signatures = [base64(await crypto.subtle.sign('Ed25519', keys.privateKey, digest))];
  const publicKey = base64(await crypto.subtle.exportKey('spki', keys.publicKey));

  assert.equal(await verifyTellerEnrollment(publicKey, 'nonce_a', enrollment, 'development'), true);
  assert.equal(await verifyTellerEnrollment(publicKey, 'nonce_b', enrollment, 'development'), false);
  assert.equal(await verifyTellerEnrollment(publicKey, 'nonce_a', enrollment, 'production'), false);
  assert.equal(await verifyTellerEnrollment(publicKey, 'nonce_a', { ...enrollment, signatures: [] }, 'development'), false);
});

test('provider access tokens round-trip through AES-GCM storage', async () => {
  const sealed = await sealSecret('token_secret', 'test encryption secret');
  assert.match(sealed, /^enc:v1:/);
  assert.notEqual(sealed, 'token_secret');
  assert.equal(await openSecret(sealed, 'test encryption secret'), 'token_secret');
  await assert.rejects(openSecret(sealed, 'wrong secret'), /Unable to decrypt/);
  assert.equal(await openSecret('legacy_plaintext', ''), 'legacy_plaintext');
});
