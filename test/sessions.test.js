import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

import { connect, clear, disconnect } from './helpers/db.js';
import User from '../models/User.js';
import Role from '../models/Role.js';
import Session from '../models/Session.js';
import RefreshToken from '../models/RefreshToken.js';
import { protect } from '../middlewares/auth.js';
import {
  login,
  logout,
  refreshAccessToken,
  getSessions,
  deleteSession,
  signOutOtherSessions,
  updatePassword
} from '../controllers/authController.js';
import { issueRefreshToken } from '../utils/refreshTokens.js';
import { describeDevice, deviceLabel } from '../utils/userAgent.js';
import { authenticateSocketToken } from '../utils/socket.js';
import { noteSignIn, signInAlertDeps } from '../utils/signInAlert.js';
import {
  getUserSessions,
  deleteUserSession,
  signOutUserEverywhere
} from '../controllers/userController.js';

process.env.JWT_SECRET ??= 'test-secret';
// Signing in from a second device sends an alert email; nothing in the suite may reach a mail server.
signInAlertDeps.send = async () => {};

before(connect);
after(disconnect);
afterEach(clear);

const CHROME_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const makeUser = async (email = 'ali@b-ledger.pk') => {
  const role = await Role.create({ name: `Tester ${email}`, permissions: [] });
  return User.create({
    name: email.split('@')[0],
    email,
    phone: `+9230${Math.floor(10000000 + Math.random() * 89999999)}`,
    password: 'password1',
    role: role._id
  });
};

/** Run a controller to its JSON reply, with cookies captured; rejects with its `next(err)`. */
const run = (handler, req) =>
  new Promise((resolve, reject) => {
    const cookies = {};
    const cleared = [];
    const res = {
      statusCode: 200,
      cookie: (name, value) => {
        cookies[name] = value;
      },
      clearCookie: name => cleared.push(name),
      status(code) {
        this.statusCode = code;
        return this;
      },
      json: body => resolve({ body, cookies, cleared, status: res.statusCode })
    };
    Promise.resolve(handler(req, res, reject)).catch(reject);
  });

const signIn = async (user, userAgent, ip) => {
  const { body, cookies } = await run(login, {
    body: { email: user.email, password: 'password1' },
    headers: { 'user-agent': userAgent },
    ip
  });
  return { token: body.token, cookie: cookies.refreshToken };
};

const runProtect = (token, extra = {}) =>
  new Promise(resolve => {
    const req = {
      headers: { authorization: `Bearer ${token}` },
      method: 'GET',
      body: {},
      ...extra
    };
    protect(req, {}, err => resolve({ err, req }));
  });

test('a user agent reads as a person would say it', () => {
  assert.equal(deviceLabel(describeDevice(CHROME_WIN)), 'Chrome on Windows');
  assert.equal(deviceLabel(describeDevice(SAFARI_IPHONE)), 'Safari on iPhone');
  assert.equal(describeDevice(SAFARI_IPHONE).kind, 'mobile');
  assert.equal(describeDevice('Mozilla/5.0 (Linux; Android 14) Chrome/126 Mobile').os, 'Android');
  assert.equal(describeDevice('Edg/126.0 Windows NT 10.0 Chrome/126').browser, 'Edge');
  assert.deepEqual(describeDevice(undefined), {
    browser: 'Unknown browser',
    os: 'Unknown device',
    kind: 'desktop'
  });
});

test('signing in starts a session that names the device, and the token carries it', async () => {
  const user = await makeUser();
  const { token, cookie } = await signIn(user, CHROME_WIN, '39.40.1.2');

  const [session] = await Session.find({ user: user._id });
  assert.equal(session.browser, 'Chrome');
  assert.equal(session.os, 'Windows');
  assert.equal(session.ip, '39.40.1.2');
  assert.equal(jwt.verify(token, process.env.JWT_SECRET).sid, String(session._id));
  assert.ok(cookie, 'a refresh cookie is set');
  assert.equal(
    String((await RefreshToken.findOne({ user: user._id })).session),
    String(session._id)
  );
});

test('refreshing keeps the same device and issues a token for it', async () => {
  const user = await makeUser();
  const { cookie } = await signIn(user, CHROME_WIN, '39.40.1.2');
  const { body, cookies } = await run(refreshAccessToken, { cookies: { refreshToken: cookie } });

  assert.equal(await Session.countDocuments({ user: user._id }), 1, 'still one device');
  const session = await Session.findOne({ user: user._id });
  assert.equal(jwt.verify(body.token, process.env.JWT_SECRET).sid, String(session._id));
  assert.notEqual(cookies.refreshToken, cookie, 'the cookie rotated');
});

test('signing one device out kills that device on its very next request, and only that one', async () => {
  const user = await makeUser();
  const laptop = await signIn(user, CHROME_WIN, '1.1.1.1');
  const phone = await signIn(user, SAFARI_IPHONE, '2.2.2.2');
  const phoneSession = await Session.findOne({ user: user._id, os: 'iPhone' });

  assert.equal((await runProtect(phone.token)).err, undefined);

  // The laptop signs the phone out.
  const laptopReq = (await runProtect(laptop.token)).req;
  await run(deleteSession, {
    user: laptopReq.user,
    sid: laptopReq.sid,
    params: { id: String(phoneSession._id) }
  });

  assert.equal((await runProtect(phone.token)).err?.statusCode, 401, 'the phone is out');
  assert.equal((await runProtect(laptop.token)).err, undefined, 'the laptop is not');
  await assert.rejects(authenticateSocketToken(phone.token), /Invalid or expired token/);
  assert.equal(await RefreshToken.countDocuments({ session: phoneSession._id }), 0);
});

test('the list shows own devices only, the current one first and marked', async () => {
  const ali = await makeUser('ali@b-ledger.pk');
  const sara = await makeUser('sara@b-ledger.pk');
  const laptop = await signIn(ali, CHROME_WIN, '1.1.1.1');
  await signIn(ali, SAFARI_IPHONE, '2.2.2.2');
  await signIn(sara, CHROME_WIN, '9.9.9.9');

  const req = (await runProtect(laptop.token)).req;
  const { body } = await run(getSessions, { user: req.user, sid: req.sid });

  assert.equal(body.count, 2, "Sara's device is not in Ali's list");
  assert.equal(body.data[0].isCurrent, true);
  assert.equal(body.data[0].os, 'Windows');
  assert.equal(body.data[1].isCurrent, false);
});

test("a person can not sign out someone else's device — it is a 404, not a 403", async () => {
  const ali = await makeUser('ali@b-ledger.pk');
  const sara = await makeUser('sara@b-ledger.pk');
  const aliLogin = await signIn(ali, CHROME_WIN, '1.1.1.1');
  await signIn(sara, CHROME_WIN, '9.9.9.9');
  const saraSession = await Session.findOne({ user: sara._id });

  const req = (await runProtect(aliLogin.token)).req;
  await assert.rejects(
    run(deleteSession, { user: req.user, sid: req.sid, params: { id: String(saraSession._id) } }),
    err => err.statusCode === 404
  );
  assert.equal(await Session.countDocuments({ user: sara._id }), 1, 'Sara is untouched');
});

test('sign out other devices keeps this one', async () => {
  const user = await makeUser();
  const laptop = await signIn(user, CHROME_WIN, '1.1.1.1');
  const phone = await signIn(user, SAFARI_IPHONE, '2.2.2.2');
  await signIn(user, CHROME_WIN, '3.3.3.3');

  const req = (await runProtect(laptop.token)).req;
  const { body } = await run(signOutOtherSessions, { user: req.user, sid: req.sid });

  assert.equal(body.data.signedOut, 2);
  assert.equal(await Session.countDocuments({ user: user._id }), 1);
  assert.equal((await runProtect(laptop.token)).err, undefined);
  assert.equal((await runProtect(phone.token)).err?.statusCode, 401);
});

test('logging out signs out this device only', async () => {
  const user = await makeUser();
  const laptop = await signIn(user, CHROME_WIN, '1.1.1.1');
  const phone = await signIn(user, SAFARI_IPHONE, '2.2.2.2');

  const req = (await runProtect(laptop.token)).req;
  await run(logout, { user: req.user, sid: req.sid, cookies: { refreshToken: laptop.cookie } });

  assert.equal((await runProtect(laptop.token)).err?.statusCode, 401, 'this device is out');
  assert.equal((await runProtect(phone.token)).err, undefined, 'the phone stays signed in');
  assert.equal(await Session.countDocuments({ user: user._id }), 1);
});

test('a copied refresh cookie, replayed after the real one moved on, cuts the device off', async () => {
  const user = await makeUser();
  const { cookie: original } = await signIn(user, CHROME_WIN, '1.1.1.1');

  // The real client refreshes: the cookie rotates.
  const { cookies } = await run(refreshAccessToken, { cookies: { refreshToken: original } });
  const current = cookies.refreshToken;
  assert.equal(await Session.countDocuments({ user: user._id }), 1);

  // A thief replays the ORIGINAL cookie.
  await assert.rejects(
    run(refreshAccessToken, { cookies: { refreshToken: original } }),
    err => err.statusCode === 401
  );

  // The whole device is revoked, so even the legitimate newest cookie is dead now.
  assert.equal(await Session.countDocuments({ user: user._id }), 0);
  await assert.rejects(
    run(refreshAccessToken, { cookies: { refreshToken: current } }),
    err => err.statusCode === 401
  );
});

test('a refresh cookie from before sessions existed adopts a session on its first refresh', async () => {
  const user = await makeUser();
  const legacy = await issueRefreshToken(user._id); // no session — the old way

  const { body } = await run(refreshAccessToken, {
    cookies: { refreshToken: legacy.token },
    headers: { 'user-agent': SAFARI_IPHONE },
    ip: '4.4.4.4'
  });

  const [session] = await Session.find({ user: user._id });
  assert.equal(session.isLegacy, true);
  assert.equal(session.os, 'iPhone');
  assert.equal(jwt.verify(body.token, process.env.JWT_SECRET).sid, String(session._id));
  assert.equal(
    (await RefreshToken.findOne({ user: user._id })).session.toString(),
    String(session._id)
  );
});

test('a token issued before sessions existed (no sid) still works until it expires', async () => {
  const user = await makeUser();
  const { err } = await runProtect(user.getSignedJwtToken());
  assert.equal(err, undefined);
});

test('changing the password leaves exactly one session: this device', async () => {
  const user = await makeUser();
  await signIn(user, SAFARI_IPHONE, '2.2.2.2');
  const laptop = await signIn(user, CHROME_WIN, '1.1.1.1');
  const req = (await runProtect(laptop.token)).req;

  const { body } = await run(updatePassword, {
    user: { id: user._id },
    sid: req.sid,
    body: { currentPassword: 'password1', newPassword: 'a-new-password-2' },
    headers: { 'user-agent': CHROME_WIN },
    ip: '1.1.1.1'
  });

  assert.equal(await Session.countDocuments({ user: user._id }), 1);
  assert.equal(
    (await runProtect(laptop.token)).err?.statusCode,
    401,
    'the old laptop token is dead (the new one replaces it)'
  );
  assert.equal((await runProtect(body.token)).err, undefined, 'the fresh token works');
});

const withKnown = id => User.findById(id).select('+knownDevices');

test('the first sign-in on a tracked account records the device silently; a new one is emailed once', async () => {
  const user = await makeUser();
  const sent = [];
  const send = async mail => sent.push(mail);
  const req = ua => ({ headers: { 'user-agent': ua }, ip: '5.5.5.5' });

  // An account never tracked before (a new user, or an old one right after the release).
  user.lastLogin = new Date();
  await user.save();
  assert.equal(await noteSignIn(await withKnown(user._id), req(CHROME_WIN), { send }), 'recorded');
  assert.equal(sent.length, 0, 'no alert for the device it began with');

  assert.equal(await noteSignIn(await withKnown(user._id), req(CHROME_WIN), { send }), 'known');
  assert.equal(sent.length, 0);

  assert.equal(
    await noteSignIn(await withKnown(user._id), req(SAFARI_IPHONE), { send }),
    'alerted'
  );
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /Safari on iPhone/);
  assert.match(sent[0].html, /Safari on iPhone/);

  // Now it is familiar.
  assert.equal(await noteSignIn(await withKnown(user._id), req(SAFARI_IPHONE), { send }), 'known');
  assert.equal(sent.length, 1);
});

test('a failing email never breaks the sign-in', async () => {
  const user = await makeUser();
  user.lastLogin = new Date();
  await user.save();
  const req = ua => ({ headers: { 'user-agent': ua } });
  await noteSignIn(await withKnown(user._id), req(CHROME_WIN), { send: async () => {} });

  const outcome = await noteSignIn(await withKnown(user._id), req(SAFARI_IPHONE), {
    send: async () => {
      throw new Error('SMTP down');
    }
  });
  assert.equal(outcome, 'alerted');
});

test('the sign-in email escapes what came from the request', async () => {
  const user = await makeUser();
  user.lastLogin = new Date();
  user.name = '<script>alert(1)</script>';
  await user.save();
  const sent = [];
  const req = ua => ({ headers: { 'user-agent': ua } });
  await noteSignIn(await withKnown(user._id), req(CHROME_WIN), { send: async m => sent.push(m) });
  await noteSignIn(await withKnown(user._id), req(SAFARI_IPHONE), {
    send: async m => sent.push(m)
  });
  assert.ok(!sent[0].html.includes('<script>'), 'no raw markup from a user name');
});

/** An admin (full access) and a plain user who may edit users, for the admin session routes. */
const makeStaff = async () => {
  const adminRole = await Role.create({ name: 'Boss', permissions: [], fullAccess: true });
  const admin = await User.create({
    name: 'Boss',
    email: 'boss@b-ledger.pk',
    phone: '+923001111111',
    password: 'password1',
    role: adminRole._id
  });
  const clerkRole = await Role.create({ name: 'Clerk', permissions: [] });
  const clerk = await User.create({
    name: 'Clerk',
    email: 'clerk@b-ledger.pk',
    phone: '+923002222222',
    password: 'password1',
    role: clerkRole._id
  });
  return {
    admin: await User.findById(admin._id).populate('role'),
    clerk: await User.findById(clerk._id).populate('role')
  };
};

test("an admin can list and remove another user's devices", async () => {
  const { admin } = await makeStaff();
  const ali = await makeUser('ali@b-ledger.pk');
  await signIn(ali, CHROME_WIN, '1.1.1.1');
  await signIn(ali, SAFARI_IPHONE, '2.2.2.2');

  const { body } = await run(getUserSessions, { user: admin, params: { id: String(ali._id) } });
  assert.equal(body.count, 2);

  const target = body.data.find(d => d.os === 'iPhone');
  await run(deleteUserSession, {
    user: admin,
    params: { id: String(ali._id), sid: String(target._id) }
  });
  assert.equal(await Session.countDocuments({ user: ali._id }), 1);

  await assert.rejects(
    run(deleteUserSession, {
      user: admin,
      params: { id: String(ali._id), sid: String(target._id) }
    }),
    err => err.statusCode === 404,
    'a device already gone is a 404'
  );
});

test("a non-admin who may edit users can not touch an Admin's sign-ins", async () => {
  const { admin, clerk } = await makeStaff();
  await signIn(admin, CHROME_WIN, '1.1.1.1');

  await assert.rejects(
    run(getUserSessions, { user: clerk, params: { id: String(admin._id) } }),
    err => err.statusCode === 403
  );
  await assert.rejects(
    run(signOutUserEverywhere, { user: clerk, params: { id: String(admin._id) } }),
    err => err.statusCode === 403
  );
  assert.equal(await Session.countDocuments({ user: admin._id }), 1, 'the Admin is untouched');
});

test('sign out everywhere also kills a token from before sessions existed', async () => {
  const { admin } = await makeStaff();
  const ali = await makeUser('ali@b-ledger.pk');
  const newer = await signIn(ali, CHROME_WIN, '1.1.1.1');
  const legacyToken = (await User.findById(ali._id).select('+tokenVersion')).getSignedJwtToken();
  assert.equal((await runProtect(legacyToken)).err, undefined);

  const { body } = await run(signOutUserEverywhere, {
    user: admin,
    params: { id: String(ali._id) }
  });

  assert.equal(body.data.signedOut, 1);
  assert.equal(await Session.countDocuments({ user: ali._id }), 0);
  assert.equal((await runProtect(newer.token)).err?.statusCode, 401);
  assert.equal((await runProtect(legacyToken)).err?.statusCode, 401, 'the no-sid token dies too');
});

test('a bad user id is a 404, not a crash', async () => {
  const { admin } = await makeStaff();
  await assert.rejects(
    run(getUserSessions, { user: admin, params: { id: 'not-an-id' } }),
    err => err.statusCode === 404
  );
});
