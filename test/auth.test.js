import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { connect, clear, disconnect } from './helpers/db.js';
import User from '../models/User.js';
import Role from '../models/Role.js';
import RefreshToken from '../models/RefreshToken.js';
import { protect } from '../middlewares/auth.js';
import {
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken
} from '../utils/refreshTokens.js';

// getSignedJwtToken signs with these; the test run doesn't load an .env.
process.env.JWT_SECRET ??= 'test-secret';
process.env.JWT_EXPIRE ??= '1h';

before(connect);
after(disconnect);
afterEach(clear);

/** Run the real `protect` middleware with a Bearer token; resolve { err, req }. */
const runProtect = token =>
  new Promise(resolve => {
    const req = { headers: { authorization: `Bearer ${token}` }, method: 'GET', body: {} };
    protect(req, {}, err => resolve({ err, req }));
  });

const makeUser = async () => {
  const role = await Role.create({ name: 'Tester', permissions: [] });
  return User.create({
    name: 'Ali',
    email: 'ali@b-ledger.pk',
    phone: '+923001234567',
    password: 'password1',
    role: role._id
  });
};

test('protect accepts a token carrying the current tokenVersion', async () => {
  const user = await makeUser();
  const { err, req } = await runProtect(user.getSignedJwtToken());
  assert.equal(err, undefined);
  assert.equal(String(req.user._id), String(user._id));
});

test('protect rejects a token after tokenVersion is bumped (logout / password change)', async () => {
  const user = await makeUser();
  const staleToken = user.getSignedJwtToken(); // version 0
  await User.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } }); // e.g. logout
  const { err } = await runProtect(staleToken);
  assert.ok(err, 'a token minted before the bump must be rejected');
  assert.equal(err.statusCode, 401);
});

test('a token re-issued after the bump is accepted again', async () => {
  const user = await makeUser();
  await User.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } });
  const refreshed = await User.findById(user._id).select('+tokenVersion');
  const { err } = await runProtect(refreshed.getSignedJwtToken());
  assert.equal(err, undefined);
});

test('refresh tokens are stored only as a hash, never in plaintext', async () => {
  const user = await makeUser();
  const { token } = await issueRefreshToken(user._id);
  const row = await RefreshToken.findOne({ user: user._id }).select('+tokenHash');
  assert.notEqual(row.tokenHash, token); // stored hashed
  assert.equal(row.tokenHash.length, 64); // sha-256 hex
});

test('rotation consumes the presented token and issues a new one', async () => {
  const user = await makeUser();
  const { token } = await issueRefreshToken(user._id);
  const rotated = await rotateRefreshToken(token);
  assert.equal(String(rotated.userId), String(user._id));
  assert.notEqual(rotated.token, token); // fresh token
  assert.equal(await RefreshToken.countDocuments({ user: user._id }), 1); // old gone, new in
});

test('a replayed (already-rotated) token is rejected — reuse defence', async () => {
  const user = await makeUser();
  const { token } = await issueRefreshToken(user._id);
  await rotateRefreshToken(token); // legit rotation
  const replay = await rotateRefreshToken(token); // attacker replays the old one
  assert.equal(replay, null);
});

test('revoke deletes a specific refresh token (logout)', async () => {
  const user = await makeUser();
  const { token } = await issueRefreshToken(user._id);
  await revokeRefreshToken(token);
  assert.equal(await RefreshToken.countDocuments({ user: user._id }), 0);
  assert.equal(await rotateRefreshToken(token), null); // can't refresh after logout
});
