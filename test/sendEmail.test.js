import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transportOptions } from '../utils/sendEmail.js';

/**
 * The mail server's certificate is checked unless someone deliberately turns it
 * off — a password sent to an impostor server is the risk.
 */
test('verifies the mail server certificate by default', () => {
  assert.equal(transportOptions({ SMTP_HOST: 'smtp.example.com' }).tls.rejectUnauthorized, true);
});

test('only the exact value "false" turns verification off', () => {
  const off = env => transportOptions(env).tls.rejectUnauthorized;
  assert.equal(off({ SMTP_REJECT_UNAUTHORIZED: 'false' }), false);
  assert.equal(off({ SMTP_REJECT_UNAUTHORIZED: 'true' }), true);
  assert.equal(off({ SMTP_REJECT_UNAUTHORIZED: '' }), true);
  assert.equal(off({ SMTP_REJECT_UNAUTHORIZED: '0' }), true);
});

test('port 465 is implicit TLS, anything else is not; the default port is 587', () => {
  assert.equal(transportOptions({ SMTP_PORT: '465' }).secure, true);
  assert.equal(transportOptions({ SMTP_PORT: '587' }).secure, false);
  assert.equal(transportOptions({ SMTP_PORT: '1025' }).secure, false);
  assert.equal(transportOptions({}).port, 587);
});

test('login details are sent only when a user is configured', () => {
  assert.equal('auth' in transportOptions({ SMTP_HOST: 'localhost', SMTP_PORT: '1025' }), false);
  assert.deepEqual(transportOptions({ SMTP_USER: 'me', SMTP_PASS: 'pw' }).auth, {
    user: 'me',
    pass: 'pw'
  });
});
