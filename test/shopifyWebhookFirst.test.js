import { test, before, after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, makeBusiness, oid } from './helpers/db.js';
import { fakeShopify, orderNode, restoreShopify } from './helpers/shopify.js';
import Role from '../models/Role.js';
import User from '../models/User.js';
import ShopifyConnection from '../models/ShopifyConnection.js';
import { encryptSecret } from '../utils/secretBox.js';
import { clearWebhookRetry, runShopifySync, syncConnection } from '../utils/shopify/sync.js';

/**
 * Shopify tells us when an order is placed (the webhook); asking every 10 minutes is then only a safety net, kept
 * hourly. A store with no webhook is still asked every pass.
 */
before(connect);
after(disconnect);

let biz;
let actor;
const keep = process.env.API_PUBLIC_URL;

const connection = extra =>
  ShopifyConnection.create({
    business: biz._id,
    shop: 'test-shop',
    clientId: 'client-id-123',
    clientSecretEnc: encryptSecret('shpss_test_secret_123456'),
    isActive: true,
    goLiveAt: new Date('2020-01-01T00:00:00Z'),
    createdBy: actor._id,
    ...extra
  });

beforeEach(async () => {
  biz = await makeBusiness({ name: 'Qam Style' });
  const admin = await Role.create({ name: `Admin ${oid()}`, fullAccess: true, isSystem: true });
  actor = await User.create({
    name: 'Connector',
    email: `w${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`,
    phone: '03001230000',
    password: 'a-long-enough-password-1',
    role: admin._id
  });
  delete process.env.API_PUBLIC_URL;
});

afterEach(async () => {
  restoreShopify();
  clearWebhookRetry();
  if (keep === undefined) delete process.env.API_PUBLIC_URL;
  else process.env.API_PUBLIC_URL = keep;
  await clear();
});

const minutesAgo = n => new Date(Date.now() - n * 60_000);

test('a store the webhook covers is not asked again within the hour', async () => {
  const fake = fakeShopify({ orders: [] });
  await connection({ webhookActive: true, lastSyncAt: minutesAgo(10) });

  await runShopifySync();
  assert.equal(fake.orderQueries, 0, 'no question: Shopify tells us about every order');
});

test('…but is double-checked once an hour has passed, in case an order was missed', async () => {
  const fake = fakeShopify({ orders: [] });
  await connection({ webhookActive: true, lastSyncAt: minutesAgo(90) });

  await runShopifySync();
  assert.equal(fake.orderQueries, 1);
});

test('a store with no webhook is asked on every pass, and a first pass always asks', async () => {
  const fake = fakeShopify({ orders: [] });
  await connection({ webhookActive: false, lastSyncAt: minutesAgo(10) });

  await runShopifySync();
  assert.equal(fake.orderQueries, 1);

  await ShopifyConnection.deleteMany({});
  await connection({ webhookActive: true });
  await runShopifySync();
  assert.equal(fake.orderQueries, 2, 'never checked yet: it is checked');
});

test('"Check now" for one business always asks, webhook or not', async () => {
  const fake = fakeShopify({ orders: [] });
  await connection({ webhookActive: true, lastSyncAt: minutesAgo(1) });

  await runShopifySync({ business: biz._id });
  assert.equal(fake.orderQueries, 1);
});

test('when a public address is set, the webhook is set up by itself on the next pass — no one has to reconnect', async () => {
  const fake = fakeShopify({ orders: [] });
  const c = await connection({ webhookActive: false });
  process.env.API_PUBLIC_URL = 'https://backend.example.com';

  await syncConnection(c._id);
  assert.equal(fake.webhookCalls, 1);
  assert.equal((await ShopifyConnection.findById(c._id)).webhookActive, true);

  await syncConnection(c._id);
  assert.equal(fake.webhookCalls, 1, 'once it is set up it is not asked for again');
});

test('a webhook Shopify refuses is retried at most once an hour, and the 10-minute check carries on', async () => {
  const fake = fakeShopify({ orders: [orderNode({ number: 51486 })], webhookFail: true });
  const c = await connection({ webhookActive: false });
  process.env.API_PUBLIC_URL = 'https://backend.example.com';

  await syncConnection(c._id);
  await syncConnection(c._id);
  assert.equal(fake.webhookCalls, 1, 'not hammered');
  assert.equal((await ShopifyConnection.findById(c._id)).webhookActive, false);
  assert.ok(fake.orderQueries >= 2, 'orders still come in by asking');
});

test('with no public address nothing is registered at all', async () => {
  const fake = fakeShopify({ orders: [] });
  const c = await connection({ webhookActive: false });

  await syncConnection(c._id);
  assert.equal(fake.webhookCalls, 0);
});
