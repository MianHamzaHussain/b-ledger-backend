import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { connect, clear, disconnect } from './helpers/db.js';
import User from '../models/User.js';
import Role from '../models/Role.js';
import RefreshToken from '../models/RefreshToken.js';
import { protect } from '../middlewares/auth.js';
import { login, updatePassword, resetPassword } from '../controllers/authController.js';
import {
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken
} from '../utils/refreshTokens.js';
import { authenticateSocketToken } from '../utils/socket.js';

// getSignedJwtToken signs with this; the test run doesn't load an .env.
// (JWT_ACCESS_EXPIRE defaults to 15m in the method, so no need to set it here.)
process.env.JWT_SECRET ??= 'test-secret';

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

test('protect stamps createdBy on a bodiless POST without crashing (Express 5)', async () => {
  const user = await makeUser();
  // No `body` key at all — Express 5 leaves it undefined on a bodiless request
  // (e.g. POST /users/:id/reinvite). protect must default it, not throw.
  const req = { headers: { authorization: `Bearer ${user.getSignedJwtToken()}` }, method: 'POST' };
  const err = await new Promise(resolve => protect(req, {}, resolve));
  assert.equal(err, undefined);
  assert.equal(String(req.body.createdBy), String(user._id));
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

/** Run a controller to its JSON reply; resolves { body, cookies } or rejects with its next(err). */
const runController = (handler, req) =>
  new Promise((resolve, reject) => {
    const cookies = [];
    const res = {
      cookie: (name, value) => cookies.push({ name, value }),
      status() {
        return this;
      },
      json: body => resolve({ body, cookies })
    };
    handler(req, res, reject);
  });

test('two requests presenting the same refresh token: exactly one wins', async () => {
  const user = await makeUser();
  const { token } = await issueRefreshToken(user._id);
  const results = await Promise.all([rotateRefreshToken(token), rotateRefreshToken(token)]);
  assert.equal(
    results.filter(Boolean).length,
    1,
    'a stolen copy must not rotate alongside the real one'
  );
});

test('changing the password signs out every OTHER device, not just their access tokens', async () => {
  const user = await makeUser();
  const laptop = await issueRefreshToken(user._id);
  const phone = await issueRefreshToken(user._id);

  const { cookies } = await runController(updatePassword, {
    user: { id: user._id },
    body: { currentPassword: 'password1', newPassword: 'a-new-password-2' }
  });

  assert.equal(await rotateRefreshToken(laptop.token), null, 'the old laptop cookie must be dead');
  assert.equal(await rotateRefreshToken(phone.token), null, 'the old phone cookie must be dead');
  // The device that changed it stays signed in on the cookie the reply set.
  const fresh = cookies.find(c => c.name === 'refreshToken');
  assert.ok(fresh, 'the reply sets a new refresh cookie for this device');
  assert.ok(await rotateRefreshToken(fresh.value), 'and that cookie works');
});

test('a password reset also signs out every device', async () => {
  const user = await makeUser();
  const stolen = await issueRefreshToken(user._id);
  const resetToken = user.getResetPasswordToken();
  await user.save({ validateBeforeSave: false });

  await runController(resetPassword, {
    params: { resettoken: resetToken },
    body: { password: 'brand-new-pass-3' }
  });

  assert.equal(await rotateRefreshToken(stolen.token), null);
});

test('a signed-out device can not open the live socket with its old access token', async () => {
  const user = await makeUser();
  const token = user.getSignedJwtToken();
  assert.equal(String((await authenticateSocketToken(token))._id), String(user._id));

  await User.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } });
  await assert.rejects(authenticateSocketToken(token), /Invalid or expired token/);
});

test('the socket refuses a missing or inactive user', async () => {
  await assert.rejects(authenticateSocketToken(undefined), /No token provided/);
  const user = await makeUser();
  const token = user.getSignedJwtToken();
  await User.updateOne({ _id: user._id }, { $set: { status: 'inactive' } });
  await assert.rejects(authenticateSocketToken(token), /not found or inactive/);
});

test('a fresh sign-in token works for a user whose sessions were revoked before', async () => {
  const user = await makeUser();
  // Setting or changing a password bumps tokenVersion to revoke old sessions.
  await User.updateOne({ _id: user._id }, { $set: { tokenVersion: 2 } });

  const token = await new Promise((resolve, reject) => {
    const res = {
      cookie() {},
      status() {
        return this;
      },
      json: body => resolve(body.token)
    };
    login({ body: { email: 'ali@b-ledger.pk', password: 'password1' } }, res, reject);
  });

  const { err } = await runProtect(token);
  assert.equal(err, undefined, 'the token from sign-in must pass protect straight away');
});
