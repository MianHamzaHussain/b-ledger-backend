import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, makeBusiness, oid } from './helpers/db.js';
import { callHandler, fakeShopify, restoreShopify, signBody } from './helpers/shopify.js';
import Role from '../models/Role.js';
import User from '../models/User.js';
import Notification from '../models/Notification.js';
import Order from '../models/Order.js';
import ShopifyApp from '../models/ShopifyApp.js';
import ShopifyConnection from '../models/ShopifyConnection.js';
import ShopifyHold from '../models/ShopifyHold.js';
import ShopifyVariantLink from '../models/ShopifyVariantLink.js';
import { encryptSecret } from '../utils/secretBox.js';
import { receiveAppWebhook } from '../controllers/shopifyWebhookController.js';

/**
 * B Ledger's own Shopify app tells us things by itself, for every store, at one address: an order was placed, the app was removed,
 * and Shopify's three privacy requests. Each call is signed over its exact bytes; one that is not gets 401 and nothing happens.
 * Redacting a shop deletes what B Ledger keeps ABOUT Shopify — but the orders already brought in stay: they are the business's own.
 */
const SECRET = 'pubsecret_test_123456';
const kept = {};

before(async () => {
  await connect();
  for (const key of ['SHOPIFY_API_KEY', 'SHOPIFY_API_SECRET']) kept[key] = process.env[key];
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
  process.env.SHOPIFY_API_KEY = 'pubkey_test_12345';
  process.env.SHOPIFY_API_SECRET = SECRET;
  biz = await makeBusiness({ name: 'Qam Style' });
  const role = await Role.create({ name: `Admin ${oid()}`, fullAccess: true, isSystem: true });
  admin = await User.create({
    name: 'Owner',
    email: `w${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`,
    phone: '03001230000',
    password: 'a-long-enough-password-1',
    role: role._id
  });
});
afterEach(async () => {
  restoreShopify();
  await clear();
});

const connection = (extra = {}) =>
  ShopifyConnection.create({
    business: biz._id,
    shop: 'test-shop',
    authType: 'oauth',
    isActive: true,
    goLiveAt: new Date('2020-01-01T00:00:00Z'),
    createdBy: admin._id,
    accessTokenEnc: encryptSecret('at_live'),
    refreshTokenEnc: encryptSecret('rt_live'),
    tokenExpiresAt: new Date(Date.now() + 3_000_000),
    ...extra
  });

/** One webhook as Shopify sends it. */
const send = (
  topic,
  payload = {},
  { shop = 'test-shop', secret = SECRET, tamper = false } = {}
) => {
  const raw = Buffer.from(JSON.stringify(payload));
  return callHandler(receiveAppWebhook, {
    headers: {
      'X-Shopify-Shop-Domain': `${shop}.myshopify.com`,
      'X-Shopify-Topic': topic,
      'X-Shopify-Hmac-Sha256': signBody(tamper ? Buffer.from('{}') : raw, secret)
    },
    body: raw
  });
};

const hold = (business, shopifyOrderId) =>
  ShopifyHold.create({
    business,
    shopifyOrderId,
    name: `#${shopifyOrderId}`,
    reasons: ['No match']
  });

test('a call that is not signed by Shopify gets 401 and nothing happens', async () => {
  const fake = fakeShopify();
  await connection();
  const forged = await send('app/uninstalled', { id: 1 }, { tamper: true });
  assert.equal(forged.statusCode, 401);
  const wrongKey = await send('app/uninstalled', {}, { secret: 'not-the-secret' });
  assert.equal(wrongKey.statusCode, 401);
  const noBody = await callHandler(receiveAppWebhook, {
    headers: { 'X-Shopify-Shop-Domain': 'test-shop.myshopify.com', 'X-Shopify-Hmac-Sha256': 'x' },
    body: { not: 'bytes' }
  });
  assert.equal(noBody.statusCode, 401);
  assert.equal((await ShopifyConnection.findOne()).isActive, true);
  assert.equal(fake.calls.length, 0);
});

test('an order placed: the store is asked what is new; a store we do not know is answered and ignored', async () => {
  const fake = fakeShopify();
  await connection();
  const res = await send('orders/create', { id: 1 });
  assert.equal(res.statusCode, 200);
  assert.equal(fake.orderQueries, 1, 'the usual import ran');

  const before = fake.calls.length;
  const stranger = await send('orders/create', { id: 2 }, { shop: 'nobody-shop' });
  assert.equal(
    stranger.statusCode,
    200,
    'the signature was good, so no hint about which stores exist'
  );
  assert.equal(fake.calls.length, before);
});

test('the app removed from the store: the connection stops, its tokens are forgotten, and the business is told', async () => {
  await connection();
  const res = await send('app/uninstalled');
  assert.equal(res.statusCode, 200);
  const saved = await ShopifyConnection.findOne().select('+accessTokenEnc +refreshTokenEnc');
  assert.equal(saved.isActive, false);
  assert.equal(saved.accessTokenEnc, undefined);
  assert.equal(saved.refreshTokenEnc, undefined);
  assert.ok(saved.uninstalledAt);
  assert.match(saved.lastError, /Reconnect/);
  const bell = await Notification.findOne({ business: biz._id });
  assert.match(bell.title, /Shopify was disconnected/);
});

test('shop/redact removes the connection, the waiting orders and the variant links — but not the orders already brought in', async () => {
  const other = await makeBusiness({ name: 'Other Shop' });
  await connection();
  await hold(biz._id, '100');
  await hold(other._id, '200');
  await ShopifyVariantLink.create({
    business: biz._id,
    shopifyVariantId: 'v1',
    product: oid(),
    variantId: oid()
  });
  await ShopifyVariantLink.create({
    business: other._id,
    shopifyVariantId: 'v2',
    product: oid(),
    variantId: oid()
  });
  // An order that came in earlier: the business's own record. (Raw insert: only its survival is being checked.)
  await Order.collection.insertOne({
    business: biz._id,
    orderNumber: '0001',
    shopifyOrderIds: ['99']
  });

  // It was uninstalled first (inactive); the redact still finds it by the store.
  await send('app/uninstalled');
  const res = await send('shop/redact', { shop_domain: 'test-shop.myshopify.com' });
  assert.equal(res.statusCode, 200);

  assert.equal(await ShopifyConnection.countDocuments(), 0);
  assert.equal(await ShopifyHold.countDocuments({ business: biz._id }), 0);
  assert.equal(await ShopifyVariantLink.countDocuments({ business: biz._id }), 0);
  assert.equal(await Order.collection.countDocuments({ business: biz._id }), 1, 'orders stay');
  // Another business is never touched.
  assert.equal(await ShopifyHold.countDocuments({ business: other._id }), 1);
  assert.equal(await ShopifyVariantLink.countDocuments({ business: other._id }), 1);
});

test('customers/redact deletes only the waiting orders of that customer', async () => {
  await connection();
  await hold(biz._id, '100');
  await hold(biz._id, '101');
  await hold(biz._id, '102');
  const res = await send('customers/redact', { orders_to_redact: [100, 101], customer: { id: 5 } });
  assert.equal(res.statusCode, 200);
  const left = await ShopifyHold.find({ business: biz._id });
  assert.deepEqual(
    left.map(row => row.shopifyOrderId),
    ['102']
  );
  assert.equal(
    (await ShopifyConnection.findOne()).isActive,
    true,
    'the connection itself is untouched'
  );
});

test('customers/data_request is acknowledged, and a person is asked to answer it', async () => {
  await connection();
  const res = await send('customers/data_request', { customer: { id: 5 } });
  assert.equal(res.statusCode, 200);
  const bell = await Notification.findOne({ business: biz._id });
  assert.match(bell.title, /asked for their data/);
});

test('a business with its own Shopify app is verified with that app’s secret, not ours', async () => {
  await connection();
  await ShopifyApp.create({
    business: biz._id,
    clientId: 'own_client_1',
    clientSecretEnc: encryptSecret('own_secret_1234'),
    installUrl: 'https://admin.shopify.com/own-install',
    createdBy: admin._id
  });
  const ours = await send('app/uninstalled', {}, { secret: SECRET });
  assert.equal(ours.statusCode, 401);
  assert.equal((await ShopifyConnection.findOne()).isActive, true);
  const theirs = await send('app/uninstalled', {}, { secret: 'own_secret_1234' });
  assert.equal(theirs.statusCode, 200);
  assert.equal((await ShopifyConnection.findOne()).isActive, false);
});
