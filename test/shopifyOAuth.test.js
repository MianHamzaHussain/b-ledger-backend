import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, makeBusiness, oid } from './helpers/db.js';
import { callHandler, fakeShopify, restoreShopify, signQuery } from './helpers/shopify.js';
import Role from '../models/Role.js';
import User from '../models/User.js';
import ShopifyApp from '../models/ShopifyApp.js';
import ShopifyConnection from '../models/ShopifyConnection.js';
import ShopifyInstall from '../models/ShopifyInstall.js';
import { getShopify } from '../controllers/shopifyController.js';
import { decryptSecret, encryptSecret } from '../utils/secretBox.js';
import { graphql } from '../utils/shopify/client.js';
import { syncConnection } from '../utils/shopify/sync.js';
import {
  beginInstall,
  claimInstall,
  createTicket,
  getPending,
  installLanding,
  oauthCallback,
  setOwnApp,
  startByShop
} from '../controllers/shopifyOAuthController.js';

/**
 * "Connect Shopify" with one click: B Ledger is a Shopify app, so an owner presses a button, approves on Shopify's own screen and
 * is connected — no keys. Shopify is a fake here: nothing in this suite can reach a real store. What is proved: the trip is tied to
 * the business that began it, every request from Shopify is checked before anything is saved, a state works once, tokens are
 * saved encrypted and renewed safely, and a refused trip changes nothing.
 */
const ENV = {
  SHOPIFY_API_KEY: 'pubkey_test_12345',
  SHOPIFY_API_SECRET: 'pubsecret_test_123456',
  SHOPIFY_INSTALL_URL: 'https://admin.shopify.com/oauth/install?client_id=pubkey_test_12345',
  API_PUBLIC_URL: 'https://api.test',
  FRONTEND_URL: 'https://app.test'
};
const SECRET = ENV.SHOPIFY_API_SECRET;
const kept = {};

before(async () => {
  await connect();
  await ShopifyConnection.init();
  for (const key of Object.keys(ENV)) kept[key] = process.env[key];
});
after(async () => {
  for (const [key, value] of Object.entries(kept)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await disconnect();
});

let biz;
let admin;
beforeEach(async () => {
  Object.assign(process.env, ENV);
  biz = await makeBusiness({ name: 'Qam Style' });
  const role = await Role.create({ name: `Admin ${oid()}`, fullAccess: true, isSystem: true });
  admin = await User.create({
    name: 'Owner',
    email: `o${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`,
    phone: '03001230000',
    password: 'a-long-enough-password-1',
    role: role._id
  });
  admin = await User.findById(admin._id).populate('role');
});
afterEach(async () => {
  restoreShopify();
  await clear();
});

const FRONT = 'https://app.test/integrations';
const stamp = () => String(Math.floor(Date.now() / 1000));
const signed = (query, secret = SECRET) => signQuery({ timestamp: stamp(), ...query }, secret);
const queryOf = url => Object.fromEntries(new URL(url).searchParams);

/** The main button: ticket → the browser opens /oauth/begin → cookie set, sent on to Shopify's install link. */
const press = async (business = biz._id) => {
  const ticketRes = await callHandler(createTicket, { user: admin, body: { business } });
  const ticket = queryOf(ticketRes.body.data.url).ticket;
  const begun = await callHandler(beginInstall, { query: { ticket } });
  return { ticket, begun, cookie: begun.cookies.bl_shopify?.value };
};

/** Shopify sends the browser to our App URL; we answer with Shopify's approval address (its `state` is ours). */
const install = async ({ cookie, shop = 'test-shop', secret = SECRET } = {}) =>
  callHandler(installLanding, {
    query: signed({ shop, host: 'abc' }, secret),
    cookies: cookie ? { bl_shopify: cookie } : {}
  });

const callback = (
  state,
  { shop = 'test-shop', code = 'code_abc', secret = SECRET, extra = {} } = {}
) => callHandler(oauthCallback, { query: signed({ shop, code, state, ...extra }, secret) });

const stateOf = res => queryOf(res.redirectedTo).state;
const reasonOf = res => queryOf(res.redirectedTo).reason;
const connections = () => ShopifyConnection.countDocuments();

test('the button: a ticket opens /begin, which sets a short cookie and sends the browser to Shopify’s install link', async () => {
  fakeShopify();
  const { begun, cookie } = await press();
  assert.equal(begun.redirectedTo, ENV.SHOPIFY_INSTALL_URL);
  assert.ok(cookie && cookie.length >= 32);
  assert.equal(begun.cookies.bl_shopify.httpOnly, true);
  assert.equal(begun.cookies.bl_shopify.sameSite, 'lax');
  assert.equal(begun.cookies.bl_shopify.path, '/api/v1/integrations/shopify');
  assert.equal(begun.cookies.bl_shopify.maxAge, 10 * 60 * 1000);
  // Only hashes are kept: the cookie value is not in the database.
  const saved = await ShopifyInstall.findOne({ kind: 'start' }).lean();
  assert.ok(saved.cookieHash && !JSON.stringify(saved).includes(cookie));
  assert.equal(saved.ticketHash, undefined, 'the ticket was burned');
});

test('a ticket works once; a spent or unknown one is refused and sets no cookie', async () => {
  const { ticket } = await press();
  const again = await callHandler(beginInstall, { query: { ticket } });
  assert.equal(reasonOf(again), 'expired');
  assert.equal(again.cookies.bl_shopify, undefined);
  const wrong = await callHandler(beginInstall, { query: { ticket: 'nope' } });
  assert.equal(reasonOf(wrong), 'expired');
});

test('the button is refused with a plain sentence when the Shopify app is not set up on this server', async () => {
  delete process.env.SHOPIFY_API_SECRET;
  await assert.rejects(
    callHandler(createTicket, { user: admin, body: { business: biz._id } }),
    /not set up on this server yet/
  );
});

test('one click end to end: connected to the business that pressed it, tokens encrypted, nothing asked of the owner', async () => {
  const fake = fakeShopify();
  const { cookie } = await press();
  const landed = await install({ cookie });

  const url = new URL(landed.redirectedTo);
  assert.equal(url.origin + url.pathname, 'https://test-shop.myshopify.com/admin/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), ENV.SHOPIFY_API_KEY);
  assert.equal(url.searchParams.get('scope'), 'read_orders,read_customers');
  assert.equal(
    url.searchParams.get('redirect_uri'),
    'https://api.test/api/v1/integrations/shopify/oauth/callback'
  );
  assert.deepEqual(
    landed.cleared,
    ['bl_shopify'],
    'the cookie is cleared once it has done its job'
  );

  const done = await callback(stateOf(landed));
  assert.equal(done.redirectedTo, `${FRONT}?shopify=connected`);
  assert.equal(fake.codeExchanges[0].expiring, 1, 'Shopify requires tokens that expire');
  assert.equal(fake.codeExchanges[0].client_id, ENV.SHOPIFY_API_KEY);

  const saved = await ShopifyConnection.findOne({ business: biz._id }).select(
    '+accessTokenEnc +refreshTokenEnc'
  );
  assert.equal(saved.authType, 'oauth');
  assert.equal(saved.shop, 'test-shop');
  assert.equal(saved.shopName, 'Test Store');
  assert.equal(saved.isActive, true);
  assert.equal(saved.scopes, 'read_orders,read_customers');
  assert.equal(saved.clientId, undefined, 'no keys are involved');
  assert.match(saved.accessTokenEnc, /^v1:/);
  assert.equal(decryptSecret(saved.accessTokenEnc), 'at_1');
  assert.equal(decryptSecret(saved.refreshTokenEnc), 'rt_1');
  // Never in any ordinary read or JSON.
  const plain = JSON.stringify(await ShopifyConnection.findOne({ business: biz._id }));
  assert.ok(!plain.includes('at_1') && !plain.includes('rt_1') && !plain.includes('Enc'));
  assert.equal(await ShopifyInstall.countDocuments(), 0, 'the trip is forgotten once finished');
});

test('typing the store address works without a cookie, and cleans what was pasted', async () => {
  fakeShopify();
  const res = await callHandler(startByShop, {
    user: admin,
    body: { business: biz._id, shop: 'https://Test-Shop.myshopify.com/admin' }
  });
  const url = new URL(res.body.data.url);
  assert.equal(url.hostname, 'test-shop.myshopify.com');
  const done = await callback(url.searchParams.get('state'));
  assert.equal(done.redirectedTo, `${FRONT}?shopify=connected`);
  assert.equal((await ShopifyConnection.findOne({ business: biz._id })).authType, 'oauth');
});

test('a store address that is not a store is refused before anything is saved', async () => {
  for (const shop of ['evil.com/x', 'a b', 'shop.evil.com', '@x', '']) {
    await assert.rejects(
      callHandler(startByShop, { user: admin, body: { business: biz._id, shop } }),
      /store address/,
      shop
    );
  }
  assert.equal(await ShopifyInstall.countDocuments(), 0);
});

test('everything wrong at the callback is refused, nothing is saved, and the browser goes back into the app with a reason', async () => {
  const fake = fakeShopify();
  const begin = async () => stateOf(await install({ cookie: (await press()).cookie }));

  // A forged signature.
  let state = await begin();
  let res = await callback(state, { secret: 'not-the-secret' });
  assert.equal(reasonOf(res), 'invalid');

  // A signed link that is too old.
  state = await begin();
  res = await callHandler(oauthCallback, {
    query: signQuery(
      {
        timestamp: String(Math.floor(Date.now() / 1000) - 3600),
        shop: 'test-shop',
        code: 'c',
        state
      },
      SECRET
    )
  });
  assert.equal(reasonOf(res), 'invalid');

  // A state made for another store.
  state = await begin();
  res = await callback(state, { shop: 'another-shop' });
  assert.equal(reasonOf(res), 'invalid');

  // A state we never made.
  res = await callback('f'.repeat(64));
  assert.equal(reasonOf(res), 'expired');

  // A state that ran out.
  state = await begin();
  await ShopifyInstall.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  res = await callback(state);
  assert.equal(reasonOf(res), 'expired');

  // A shop that is not a shop.
  state = await begin();
  res = await callback(state, { shop: 'evil.com' });
  assert.equal(reasonOf(res), 'invalid');

  assert.equal(await connections(), 0);
  assert.equal(fake.codeExchanges.length, 0, 'the code was never traded for tokens');
});

test('a state works once: a replay is refused', async () => {
  fakeShopify();
  const state = stateOf(await install({ cookie: (await press()).cookie }));
  assert.equal((await callback(state)).redirectedTo, `${FRONT}?shopify=connected`);
  assert.equal(reasonOf(await callback(state)), 'expired');
});

test('a store that did not allow what B Ledger needs is refused', async () => {
  fakeShopify({ grantedScope: 'read_products' });
  const state = stateOf(await install({ cookie: (await press()).cookie }));
  assert.equal(reasonOf(await callback(state)), 'denied');
  assert.equal(await connections(), 0);
});

test('Shopify saying no to the code changes nothing', async () => {
  fakeShopify({ codeStatus: 400 });
  const state = stateOf(await install({ cookie: (await press()).cookie }));
  assert.equal(reasonOf(await callback(state)), 'failed');
  assert.equal(await connections(), 0);
});

test('a person who lost access between pressing the button and approving can not connect it', async () => {
  fakeShopify();
  const state = stateOf(await install({ cookie: (await press()).cookie }));
  await User.updateOne({ _id: admin._id }, { $set: { status: 'inactive' } });
  assert.equal(reasonOf(await callback(state)), 'permission');
  assert.equal(await connections(), 0);
});

test('a store already linked to another business is refused — one store, one business', async () => {
  fakeShopify();
  const other = await makeBusiness({ name: 'Other Shop' });
  await ShopifyConnection.create({
    business: other._id,
    shop: 'test-shop',
    authType: 'oauth',
    isActive: true,
    goLiveAt: new Date(),
    createdBy: admin._id
  });
  // Typing the address says so at once…
  await assert.rejects(
    callHandler(startByShop, { user: admin, body: { business: biz._id, shop: 'test-shop' } }),
    /already linked to another business/
  );
  // …and so does an install that reaches the callback.
  const state = stateOf(await install({ cookie: (await press()).cookie }));
  assert.equal(reasonOf(await callback(state)), 'taken');
  assert.equal(await ShopifyConnection.countDocuments({ business: biz._id }), 0);
});

test('connecting again replaces the business’s old connection but keeps the day it went live', async () => {
  fakeShopify();
  const live = new Date('2026-01-01T00:00:00Z');
  await ShopifyConnection.create({
    business: biz._id,
    shop: 'test-shop',
    clientId: 'client-id-123',
    clientSecretEnc: encryptSecret('shpss_test_secret_123456'),
    goLiveAt: live,
    createdBy: admin._id
  });
  const state = stateOf(await install({ cookie: (await press()).cookie }));
  await callback(state);
  const rows = await ShopifyConnection.find({ business: biz._id }).select('+clientSecretEnc');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].authType, 'oauth');
  assert.equal(rows[0].clientSecretEnc, undefined, 'the old secret is forgotten');
  assert.equal(rows[0].goLiveAt.getTime(), live.getTime(), 'no earlier order is brought in twice');
});

// ---- tokens: they expire after an hour and are renewed safely --------------------------------------------------------------

const oauthConnection = async (extra = {}) =>
  ShopifyConnection.create({
    business: biz._id,
    shop: 'test-shop',
    authType: 'oauth',
    isActive: true,
    goLiveAt: new Date('2020-01-01T00:00:00Z'),
    createdBy: admin._id,
    accessTokenEnc: encryptSecret('old_at'),
    refreshTokenEnc: encryptSecret('old_rt'),
    tokenExpiresAt: new Date(Date.now() + 60_000),
    ...extra
  });

test('an access token that is about to end is renewed once, even when two requests ask together', async () => {
  const fake = fakeShopify();
  const conn = await oauthConnection();
  await Promise.all([graphql(conn, '{ shop { name } }'), graphql(conn, '{ shop { name } }')]);
  assert.equal(fake.refreshes.length, 1);
  assert.equal(fake.refreshes[0].refresh_token, 'old_rt');
  assert.deepEqual(fake.graphqlTokens, ['at_1', 'at_1']);

  const saved = await ShopifyConnection.findById(conn._id).select(
    '+accessTokenEnc +refreshTokenEnc'
  );
  assert.equal(decryptSecret(saved.accessTokenEnc), 'at_1');
  assert.equal(
    decryptSecret(saved.refreshTokenEnc),
    'rt_1',
    'the rotated refresh token is saved with it'
  );
  assert.equal(saved.tokenVersion, 1);

  // A token with time left is simply used.
  await graphql(saved, '{ shop { name } }');
  assert.equal(fake.refreshes.length, 1);
});

test('if another renewal won the race, its token is used and the winner’s pair is not overwritten', async () => {
  const conn = await oauthConnection();
  const fake = fakeShopify({
    onRefresh: () =>
      ShopifyConnection.updateOne(
        { _id: conn._id },
        {
          $set: {
            accessTokenEnc: encryptSecret('winner_at'),
            refreshTokenEnc: encryptSecret('winner_rt'),
            tokenExpiresAt: new Date(Date.now() + 3_000_000)
          },
          $inc: { tokenVersion: 1 }
        }
      )
  });
  await graphql(conn, '{ shop { name } }');
  assert.deepEqual(fake.graphqlTokens, ['winner_at']);
  const saved = await ShopifyConnection.findById(conn._id).select(
    '+accessTokenEnc +refreshTokenEnc'
  );
  assert.equal(decryptSecret(saved.accessTokenEnc), 'winner_at');
  assert.equal(decryptSecret(saved.refreshTokenEnc), 'winner_rt');
});

test('when Shopify refuses a renewal the connection stops and says it must be connected again', async () => {
  fakeShopify({ refreshStatus: 400 });
  const conn = await oauthConnection();
  await assert.rejects(graphql(conn, '{ shop { name } }'), err => err.reconnect === true);
  const saved = await ShopifyConnection.findById(conn._id);
  assert.equal(saved.isActive, false);
  assert.match(saved.lastError, /connected again/);
});

test('a busy Shopify during a renewal is tried again later and does not disconnect anything', async () => {
  fakeShopify({ refreshStatus: 503 });
  const conn = await oauthConnection();
  await assert.rejects(graphql(conn, '{ shop { name } }'), err => err.retryable === true);
  assert.equal((await ShopifyConnection.findById(conn._id)).isActive, true);
});

// ---- an install that begins on Shopify's side (no cookie): the person chooses the business afterwards -----------------------

const pendingTicket = async () => {
  const landed = await install();
  const done = await callback(stateOf(landed));
  const url = new URL(done.redirectedTo);
  assert.equal(url.origin + url.pathname, 'https://app.test/integrations/shopify/finish');
  return url.searchParams.get('ticket');
};

test('install from Shopify with no cookie: approval waits, the person signs in and chooses the business', async () => {
  fakeShopify();
  const ticket = await pendingTicket();
  assert.equal(await connections(), 0, 'nothing is linked until a person chooses');

  const waiting = await callHandler(getPending, { user: admin, query: { ticket } });
  assert.deepEqual(waiting.body.data, { shop: 'test-shop' });

  const claimed = await callHandler(claimInstall, {
    user: admin,
    body: { ticket, business: biz._id }
  });
  assert.equal(claimed.body.data.shop, 'test-shop');
  const saved = await ShopifyConnection.findOne({ business: biz._id }).select('+accessTokenEnc');
  assert.equal(saved.authType, 'oauth');
  assert.equal(decryptSecret(saved.accessTokenEnc), 'at_1');
  assert.equal(await ShopifyInstall.countDocuments(), 0);

  await assert.rejects(
    callHandler(claimInstall, { user: admin, body: { ticket, business: biz._id } }),
    /expired/
  );
});

test('a waiting install is gone after an hour, and an unknown ticket is refused', async () => {
  fakeShopify();
  const ticket = await pendingTicket();
  await ShopifyInstall.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  await assert.rejects(
    callHandler(claimInstall, { user: admin, body: { ticket, business: biz._id } }),
    /expired/
  );
  await assert.rejects(
    callHandler(getPending, { user: admin, query: { ticket: 'x'.repeat(40) } }),
    /expired/
  );
});

test('claiming for a business outside the person’s own is not found, and the waiting install is kept', async () => {
  fakeShopify();
  const ticket = await pendingTicket();
  await assert.rejects(
    callHandler(claimInstall, {
      user: admin,
      accessFilter: { business: { $in: [oid()] } },
      body: { ticket, business: biz._id }
    }),
    /Not found/
  );
  assert.equal(await ShopifyInstall.countDocuments({ kind: 'pending' }), 1);
});

test('claiming a store that another business already has is refused, and the install stays for the right business', async () => {
  fakeShopify();
  const ticket = await pendingTicket();
  const other = await makeBusiness({ name: 'Other Shop' });
  await ShopifyConnection.create({
    business: other._id,
    shop: 'test-shop',
    authType: 'oauth',
    isActive: true,
    goLiveAt: new Date(),
    createdBy: admin._id
  });
  await assert.rejects(
    callHandler(claimInstall, { user: admin, body: { ticket, business: biz._id } }),
    /already linked to another business/
  );
  assert.equal(await ShopifyInstall.countDocuments({ kind: 'pending' }), 1);
});

test('the App URL refuses a bad signature, and a store already connected is just shown', async () => {
  fakeShopify();
  const bad = await install({ secret: 'wrong-secret' });
  assert.equal(reasonOf(bad), 'invalid');
  assert.equal(await ShopifyInstall.countDocuments(), 0);

  await oauthConnection();
  const opened = await install();
  assert.equal(opened.redirectedTo, FRONT, 'no second connection is started');
  assert.equal(await ShopifyInstall.countDocuments(), 0);
});

// ---- a business's own Shopify app (custom distribution) -------------------------------------------------------------------

test('a business with its own Shopify app is sent to that app’s install link and connected with that app’s keys', async () => {
  const fake = fakeShopify();
  await ShopifyApp.create({
    business: biz._id,
    clientId: 'own_client_1',
    clientSecretEnc: encryptSecret('own_secret_1234'),
    installUrl: 'https://admin.shopify.com/own-install',
    createdBy: admin._id
  });
  const { begun, cookie } = await press();
  assert.equal(begun.redirectedTo, 'https://admin.shopify.com/own-install');

  // The install is signed by that app, not by ours.
  const landed = await install({ cookie, secret: 'own_secret_1234' });
  assert.equal(new URL(landed.redirectedTo).searchParams.get('client_id'), 'own_client_1');
  const state = stateOf(landed);

  assert.equal(
    reasonOf(await callback(state, { secret: SECRET })),
    'invalid',
    'ours does not match theirs'
  );
  const second = stateOf(
    await install({ cookie: (await press()).cookie, secret: 'own_secret_1234' })
  );
  const done = await callback(second, { secret: 'own_secret_1234' });
  assert.equal(done.redirectedTo, `${FRONT}?shopify=connected`);
  assert.equal(fake.codeExchanges.at(-1).client_id, 'own_client_1');
});

test('only an admin can give a business its own app, and the secret is never returned or kept in the clear', async () => {
  const body = {
    business: biz._id,
    clientId: 'own_client_1',
    clientSecret: 'own_secret_1234',
    installUrl: 'https://admin.shopify.com/own-install'
  };
  await assert.rejects(
    callHandler(setOwnApp, { user: { id: admin._id, role: { fullAccess: false } }, body }),
    /Only an admin/
  );
  const res = await callHandler(setOwnApp, { user: admin, body });
  assert.ok(!JSON.stringify(res.body).includes('own_secret_1234'));
  const saved = await ShopifyApp.findOne({ business: biz._id }).select('+clientSecretEnc').lean();
  assert.match(saved.clientSecretEnc, /^v1:/);
  assert.equal(decryptSecret(saved.clientSecretEnc), 'own_secret_1234');
  assert.equal(
    JSON.stringify(await ShopifyApp.findOne({ business: biz._id })).includes('Enc'),
    false
  );
});

test('the card is told how a store is connected, and when it must be connected again — never a key or a token', async () => {
  const read = async () =>
    (await callHandler(getShopify, { query: { business: String(biz._id) } })).body.data;

  assert.deepEqual(await read(), { connected: false, configured: true, oneClick: true });
  delete process.env.SHOPIFY_API_SECRET;
  assert.equal((await read()).configured, false, 'the card can say the server is not set up');
  process.env.SHOPIFY_API_SECRET = SECRET;

  const conn = await oauthConnection();
  const live = await read();
  assert.equal(live.authType, 'oauth');
  assert.equal(live.needsReconnect, false);
  assert.equal(live.clientId, null);
  assert.equal(live.hasSecret, false);
  assert.ok(!JSON.stringify(live).includes('at_') && !JSON.stringify(live).includes('old_'));

  await ShopifyConnection.updateOne({ _id: conn._id }, { $set: { isActive: false } });
  assert.equal((await read()).needsReconnect, true);
});

test('a business with its own Shopify app can connect even when the public app is not set up here', async () => {
  const read = async () =>
    (await callHandler(getShopify, { query: { business: String(biz._id) } })).body.data;
  delete process.env.SHOPIFY_API_SECRET;
  assert.equal((await read()).configured, false);
  await ShopifyApp.create({
    business: biz._id,
    clientId: 'own_client_1',
    clientSecretEnc: encryptSecret('own_secret_1234'),
    installUrl: 'https://admin.shopify.com/own-install',
    createdBy: admin._id
  });
  assert.equal((await read()).configured, true);
  // Another business without one is still told it is not set up.
  const other = await makeBusiness({ name: 'Other Shop' });
  const res = await callHandler(getShopify, { query: { business: String(other._id) } });
  assert.equal(res.body.data.configured, false);
  process.env.SHOPIFY_API_SECRET = SECRET;
});

test('the big button is offered only when there is an install link; typing the address needs only the keys', async () => {
  const read = async () =>
    (await callHandler(getShopify, { query: { business: String(biz._id) } })).body.data;
  delete process.env.SHOPIFY_INSTALL_URL;
  const noLink = await read();
  assert.equal(noLink.configured, true, 'the address box works without an install link');
  assert.equal(noLink.oneClick, false, 'the big button would fail, so it is not offered');
  process.env.SHOPIFY_INSTALL_URL = ENV.SHOPIFY_INSTALL_URL;
  assert.equal((await read()).oneClick, true);
});

test('a store that allowed orders but not customers is refused — the customer on an order needs both', async () => {
  fakeShopify({ grantedScope: 'read_orders' });
  const state = stateOf(await install({ cookie: (await press()).cookie }));
  assert.equal(reasonOf(await callback(state)), 'denied');
  assert.equal(await connections(), 0);
});

test('the order query asks for the customer’s name and phone, and the shipping address, never an email', async () => {
  const fake = fakeShopify();
  const conn = await oauthConnection({ tokenExpiresAt: new Date(Date.now() + 3_000_000) });
  await syncConnection(conn._id);
  assert.ok(fake.ordersQuery, 'the store was asked for orders');
  assert.ok(/customer\s*\{[^}]*firstName[^}]*lastName[^}]*phone/.test(fake.ordersQuery));
  assert.ok(/shippingAddress\s*\{[^}]*name[^}]*phone[^}]*address1[^}]*city/.test(fake.ordersQuery));
  assert.ok(!/email/.test(fake.ordersQuery), 'no email (protected data B Ledger does not use)');
});
