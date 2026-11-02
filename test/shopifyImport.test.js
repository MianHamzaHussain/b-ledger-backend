import { test, before, after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { connect, clear, disconnect, makeBusiness, oid, runHandler, userId } from './helpers/db.js';
import { fakeShopify, orderNode, restoreShopify } from './helpers/shopify.js';
import Order from '../models/Order.js';
import Product from '../models/Product.js';
import Role from '../models/Role.js';
import User from '../models/User.js';
import Notification from '../models/Notification.js';
import ShopifyConnection from '../models/ShopifyConnection.js';
import ShopifyHold from '../models/ShopifyHold.js';
import ShopifyVariantLink from '../models/ShopifyVariantLink.js';
import { encryptSecret } from '../utils/secretBox.js';
import { importOrder, retryHolds } from '../utils/shopify/importer.js';
import { syncConnection } from '../utils/shopify/sync.js';
import {
  clearShopifyCooldown,
  connectShopify,
  disconnectShopify,
  getShopify,
  ignoreHold,
  linkVariant,
  receiveShopifyWebhook,
  syncNow
} from '../controllers/shopifyController.js';

/**
 * Shopify orders come in by themselves: made once, joined when the same person orders twice the same day to the same
 * address, and held — with the reason — when they cannot be made safely. Nothing here can reach a real store.
 */
before(connect);
after(disconnect);
afterEach(async () => {
  restoreShopify();
  clearShopifyCooldown();
  await clear();
});

let biz;
let actor;
let connection;
let product;

const SECRET = 'shpss_test_secret_123456';

beforeEach(async () => {
  biz = await makeBusiness({ name: 'Qam Style' });
  const admin = await Role.create({ name: `Admin ${oid()}`, fullAccess: true, isSystem: true });
  actor = await User.create({
    name: 'Connector',
    email: `c${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`,
    phone: '03001230000',
    password: 'a-long-enough-password-1',
    role: admin._id,
    assignedBusinesses: [biz._id]
  });
  actor = await User.findById(actor._id).populate('role');
  product = await Product.create({
    business: biz._id,
    category: oid(),
    name: 'BEIGE MEHFIL',
    createdBy: userId,
    variants: [
      { label: 'M', costPrice: 0, salePrice: 16000, stock: 10 },
      { label: 'L', costPrice: 0, salePrice: 16000, stock: 10 }
    ]
  });
  connection = await ShopifyConnection.create({
    business: biz._id,
    shop: 'test-shop',
    clientId: 'client-id-123',
    clientSecretEnc: encryptSecret(SECRET),
    isActive: true,
    goLiveAt: new Date('2020-01-01T00:00:00Z'),
    createdBy: actor._id
  });
  connection = await ShopifyConnection.findById(connection._id).select(
    '+clientSecretEnc +accessTokenEnc'
  );
});

const stockOf = async label =>
  (await Product.findById(product._id)).variants.find(v => v.label === label).stock;

// ── a new order ──────────────────────────────────────────────────────────────

test('a new cash-on-delivery order is made: Created, from Shopify, with its items and stock held', async () => {
  const out = await importOrder(connection, orderNode({ number: 51486, price: 15999 }), actor);

  assert.equal(out.result, 'created');
  const order = await Order.findById(out.orderId);
  assert.equal(order.status, 'created');
  assert.equal(order.source, 'shopify');
  assert.equal(order.shopifyOrderNumber, '51486');
  assert.deepEqual(order.shopifyOrderIds, ['51486']);
  assert.equal(order.customerName, 'Arham Ali');
  assert.equal(order.deliveryAddress, 'House 190, Block B');
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].unitPrice, 15999, 'the price is what the customer saw on Shopify');
  assert.equal(order.total, 15999);
  assert.equal(await stockOf('M'), 9, 'the piece is held, as for any order');
});

test('the match by exact name and size is remembered, so the next order uses the link', async () => {
  const node = orderNode({ number: 51486, variantId: 'gid://shopify/ProductVariant/777' });
  await importOrder(connection, node, actor);

  const link = await ShopifyVariantLink.findOne({ business: biz._id, shopifyVariantId: '777' });
  assert.ok(link);
  assert.equal(link.madeBy, 'auto');
  assert.equal(String(link.product), String(product._id));
});

test('the same Shopify order brought in twice is still one order', async () => {
  const node = orderNode({ number: 51486 });
  await importOrder(connection, node, actor);
  const again = await importOrder(connection, node, actor);

  assert.equal(again.result, 'skipped');
  assert.equal(await Order.countDocuments({ business: biz._id }), 1);
  assert.equal(await stockOf('M'), 9, 'stock was held once');
});

test('an order cancelled in Shopify, or placed before it was connected, is left out', async () => {
  const cancelled = await importOrder(
    connection,
    orderNode({ cancelledAt: new Date().toISOString() }),
    actor
  );
  assert.equal(cancelled.result, 'skipped');

  await ShopifyConnection.updateOne({ _id: connection._id }, { goLiveAt: new Date() });
  const later = await ShopifyConnection.findById(connection._id);
  const old = await importOrder(
    later,
    orderNode({ createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString() }),
    actor
  );
  assert.equal(old.result, 'skipped');
  assert.equal(await Order.countDocuments({ business: biz._id }), 0);
});

// ── the same person, twice ───────────────────────────────────────────────────

test('the same person ordering twice the same day to the same address becomes ONE order, and the app says so', async () => {
  const first = await importOrder(connection, orderNode({ number: 51486 }), actor);
  const second = await importOrder(
    connection,
    orderNode({ number: 51487, variantTitle: 'L', price: 14000, address: 'house 190 block-b' }),
    actor
  );

  assert.equal(second.result, 'merged');
  assert.equal(String(second.orderId), String(first.orderId));
  assert.equal(await Order.countDocuments({ business: biz._id }), 1);

  const order = await Order.findById(first.orderId);
  assert.equal(order.items.length, 2);
  assert.equal(order.total, 16000 + 14000);
  assert.deepEqual(order.shopifyOrderIds.sort(), ['51486', '51487']);
  assert.equal(order.shopifyOrderNumber, '51486+51487');
  assert.ok(order.activity.some(a => a.system && /Another Shopify order/.test(a.text)));
  assert.equal(await stockOf('M'), 9);
  assert.equal(await stockOf('L'), 9, 'the second order’s piece is held too');

  const note = await Notification.findOne({ title: /added to #/ });
  assert.ok(note, 'a notification says a new order arrived');
  assert.match(note.body, /Shopify #51487/);
});

test('a different address, a different person, or a different day stays a separate order', async () => {
  await importOrder(connection, orderNode({ number: 51486 }), actor);

  await importOrder(connection, orderNode({ number: 51487, address: 'Shop 4, Mall Road' }), actor);
  await importOrder(
    connection,
    orderNode({ number: 51488, phone: '0311 7654321', name: 'Sana Khan' }),
    actor
  );
  await importOrder(
    connection,
    orderNode({ number: 51489, createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }),
    actor
  );

  assert.equal(await Order.countDocuments({ business: biz._id }), 4);
});

test('an order that has already been called and confirmed is never changed — the new one is separate', async () => {
  const first = await importOrder(connection, orderNode({ number: 51486 }), actor);
  await Order.updateOne({ _id: first.orderId }, { status: 'confirmed' });

  const second = await importOrder(connection, orderNode({ number: 51487 }), actor);
  assert.equal(second.result, 'created');
  assert.equal(await Order.countDocuments({ business: biz._id }), 2);
  assert.equal((await Order.findById(first.orderId)).items.length, 1);
});

test('an order still waiting after "no answer" (Pending) does take the second order', async () => {
  const first = await importOrder(connection, orderNode({ number: 51486 }), actor);
  await Order.updateOne({ _id: first.orderId }, { status: 'pending' });

  assert.equal(
    (await importOrder(connection, orderNode({ number: 51487 }), actor)).result,
    'merged'
  );
});

// ── orders that cannot be made safely ────────────────────────────────────────

test('a product that is not in stock is held with the item named, and a person is told once', async () => {
  const node = orderNode({
    number: 51486,
    title: 'UNKNOWN SUIT',
    variantId: 'gid://shopify/ProductVariant/9'
  });
  const out = await importOrder(connection, node, actor);

  assert.equal(out.result, 'held');
  assert.equal(await Order.countDocuments({ business: biz._id }), 0);
  const hold = await ShopifyHold.findOne({ business: biz._id });
  assert.equal(hold.status, 'open');
  assert.equal(hold.unmatched[0].title, 'UNKNOWN SUIT');
  assert.match(hold.reasons.join(' '), /not matched to your stock/);

  await importOrder(connection, node, actor); // tried again: still one notification
  assert.equal(await Notification.countDocuments({ type: 'shopify-attention' }), 1);
});

test('once a person matches the product, the waiting order comes in on its own and the hold closes', async () => {
  const node = orderNode({
    number: 51486,
    title: 'UNKNOWN SUIT',
    variantId: 'gid://shopify/ProductVariant/9'
  });
  await importOrder(connection, node, actor);

  await ShopifyVariantLink.create({
    business: biz._id,
    shopifyVariantId: '9',
    product: product._id,
    variantId: product.variants[0]._id
  });
  const tally = await retryHolds(connection, actor);

  assert.equal(tally.created, 1);
  assert.equal(await Order.countDocuments({ business: biz._id }), 1);
  const hold = await ShopifyHold.findOne({ business: biz._id });
  assert.equal(hold.status, 'done');
  assert.equal(hold.raw, undefined, 'Shopify’s copy is dropped once it is no longer needed');
});

test('an order paid online, or with a discount, is held for a person rather than guessed', async () => {
  const paid = await importOrder(
    connection,
    orderNode({ number: 51486, gateways: ['Bank Deposit'] }),
    actor
  );
  const discounted = await importOrder(
    connection,
    orderNode({ number: 51487, address: 'Elsewhere', discounts: 500, total: 15500 }),
    actor
  );

  assert.equal(paid.result, 'held');
  assert.match(paid.reasons.join(' '), /Not cash on delivery/);
  assert.equal(discounted.result, 'held');
  assert.equal(await Order.countDocuments({ business: biz._id }), 0);
});

test('an order a person put aside is never brought back', async () => {
  const node = orderNode({ number: 51486, gateways: ['Bank Deposit'] });
  await importOrder(connection, node, actor);
  await ShopifyHold.updateOne({ business: biz._id }, { status: 'ignored' });

  assert.equal((await importOrder(connection, node, actor)).result, 'skipped');
});

// ── the sync ─────────────────────────────────────────────────────────────────

test('a sync brings in what Shopify has, joins the duplicates, and a second sync finds nothing new', async () => {
  const fake = fakeShopify({
    orders: [orderNode({ number: 51486 }), orderNode({ number: 51487, variantTitle: 'L' })]
  });
  const first = await syncConnection(connection._id);

  assert.equal(first.created, 1);
  assert.equal(first.merged, 1);
  assert.equal(await Order.countDocuments({ business: biz._id }), 1);
  assert.ok((await ShopifyConnection.findById(connection._id)).lastSyncAt);

  const second = await syncConnection(connection._id);
  assert.equal(second.created + second.merged, 0);
  assert.equal(await Order.countDocuments({ business: biz._id }), 1);
  assert.ok(fake.tokenRequests >= 1);
});

test('a sync that cannot reach Shopify says why on the connection, and tries again next time', async () => {
  fakeShopify({ ordersFail: true });
  const out = await syncConnection(connection._id);

  assert.equal(out.errors, 1);
  const saved = await ShopifyConnection.findById(connection._id);
  assert.match(saved.lastError, /busy|tried again/i);
  assert.equal(saved.lastSyncAt, undefined);
});

test('if the person who connected Shopify is no longer active, the sync says so instead of acting as them', async () => {
  fakeShopify({ orders: [orderNode()] });
  await User.updateOne({ _id: actor._id }, { status: 'inactive' });
  await syncConnection(connection._id);

  assert.match((await ShopifyConnection.findById(connection._id)).lastError, /no longer active/);
  assert.equal(await Order.countDocuments({ business: biz._id }), 0);
});

// ── connecting ───────────────────────────────────────────────────────────────

const connectBody = extra => ({
  business: String(biz._id),
  shop: 'https://Test-Shop.myshopify.com/',
  clientId: 'client-id-123',
  clientSecret: SECRET,
  ...extra
});

test('connecting tests the credentials, saves the secret encrypted, starts today, and never sends the secret back', async () => {
  await ShopifyConnection.deleteMany({});
  fakeShopify();
  const out = await runHandler(connectShopify, {
    user: actor,
    accessFilter: {},
    body: connectBody()
  });

  assert.equal(out.body.data.connected, true);
  assert.equal(out.body.data.shop, 'test-shop', 'the address is cleaned to its subdomain');
  assert.equal(out.body.data.shopName, 'Test Store');
  assert.equal(out.body.data.hasSecret, true);
  assert.ok(!JSON.stringify(out.body).includes(SECRET));

  const saved = await ShopifyConnection.findOne({ business: biz._id }).select('+clientSecretEnc');
  assert.ok(saved.clientSecretEnc);
  assert.ok(!saved.clientSecretEnc.includes(SECRET));
  assert.ok(
    Math.abs(saved.goLiveAt.getTime() - Date.now()) < 60_000,
    'older orders are never brought in'
  );
});

test('a wrong store address, wrong id or secret, or a store in another organization each get plain words', async () => {
  await ShopifyConnection.deleteMany({});
  const attempt = () =>
    runHandler(connectShopify, { user: actor, accessFilter: {}, body: connectBody() });

  fakeShopify({ tokenStatus: 404 });
  await assert.rejects(attempt, /does not know that store address/);
  fakeShopify({ tokenStatus: 400, tokenBody: { error: 'invalid_client' } });
  await assert.rejects(attempt, /did not accept that Client ID and Client secret/);
  fakeShopify({ tokenStatus: 400, tokenBody: { error: 'shop_not_permitted' } });
  await assert.rejects(attempt, /not in the same Shopify organization/);
  assert.equal(await ShopifyConnection.countDocuments(), 0, 'nothing was saved');
});

test('a first connection must have the secret; a later change may keep the saved one', async () => {
  await ShopifyConnection.deleteMany({});
  fakeShopify();
  await assert.rejects(
    runHandler(connectShopify, {
      user: actor,
      accessFilter: {},
      body: connectBody({ clientSecret: undefined })
    }),
    /Enter the Client secret/
  );

  await runHandler(connectShopify, { user: actor, accessFilter: {}, body: connectBody() });
  const again = await runHandler(connectShopify, {
    user: actor,
    accessFilter: {},
    body: connectBody({ clientSecret: undefined, clientId: 'new-client-id-456' })
  });
  assert.equal(again.body.data.clientId, 'new-client-id-456');
});

test('the status says what is going on; a business outside the person’s own is not found', async () => {
  await Order.create({
    business: biz._id,
    customerName: 'X',
    contactNumber: '03001234567',
    city: 'Lahore',
    deliveryAddress: 'A',
    items: [],
    shopifyOrderIds: ['1'],
    createdBy: userId
  }).catch(() => {});
  await ShopifyHold.create({ business: biz._id, shopifyOrderId: '2', name: '2', reasons: ['x'] });

  const out = await runHandler(getShopify, {
    user: actor,
    accessFilter: {},
    query: { business: String(biz._id) }
  });
  assert.equal(out.body.data.connected, true);
  assert.equal(out.body.data.waiting, 1);
  assert.ok(!JSON.stringify(out.body).includes(SECRET));

  await assert.rejects(
    runHandler(getShopify, {
      user: actor,
      accessFilter: { business: { $in: [String(oid())] } },
      query: { business: String(biz._id) }
    }),
    /Not found/
  );
});

test('"check now" is limited to once a minute per business', async () => {
  fakeShopify();
  const call = () =>
    runHandler(syncNow, { user: actor, accessFilter: {}, body: { business: String(biz._id) } });
  await call();
  await assert.rejects(
    call,
    err => err.statusCode === 429 && /try again in \d+ seconds/.test(err.message)
  );
});

test('disconnecting forgets the secret but keeps every order already brought in', async () => {
  fakeShopify({ orders: [orderNode({ number: 51486 })] });
  await syncConnection(connection._id);

  await runHandler(disconnectShopify, {
    user: actor,
    accessFilter: {},
    query: { business: String(biz._id) }
  });
  assert.equal(await ShopifyConnection.countDocuments(), 0);
  assert.equal(await Order.countDocuments({ business: biz._id }), 1);
});

test('linking a product by hand is checked against this business’s stock, and releases the waiting orders', async () => {
  const node = orderNode({
    number: 51486,
    title: 'UNKNOWN SUIT',
    variantId: 'gid://shopify/ProductVariant/9'
  });
  await importOrder(connection, node, actor);

  const body = shopifyVariantId => ({
    business: String(biz._id),
    shopifyVariantId,
    product: String(product._id),
    variantId: String(product.variants[0]._id)
  });
  await assert.rejects(
    runHandler(linkVariant, {
      user: actor,
      accessFilter: {},
      body: { ...body('9'), variantId: String(oid()) }
    }),
    /not in this business/
  );

  const out = await runHandler(linkVariant, { user: actor, accessFilter: {}, body: body('9') });
  assert.equal(out.body.data.created, 1);
  assert.equal(await Order.countDocuments({ business: biz._id }), 1);
});

test('a waiting order can be put aside', async () => {
  await importOrder(connection, orderNode({ number: 51486, gateways: ['Bank Deposit'] }), actor);
  const hold = await ShopifyHold.findOne({ business: biz._id });
  await runHandler(ignoreHold, { user: actor, accessFilter: {}, params: { id: String(hold._id) } });
  assert.equal((await ShopifyHold.findById(hold._id)).status, 'ignored');
});

// ── the webhook ──────────────────────────────────────────────────────────────

/** Call the webhook handler the way Express would, with the exact bytes Shopify sent. */
const webhook = async ({
  body = '{}',
  secret = SECRET,
  shop = 'test-shop.myshopify.com',
  signature
}) => {
  const raw = Buffer.from(body);
  const sig = signature ?? crypto.createHmac('sha256', secret).update(raw).digest('base64');
  const headers = { 'x-shopify-shop-domain': shop, 'x-shopify-hmac-sha256': sig };
  const result = { code: null };
  const res = {
    headersSent: false,
    status(code) {
      result.code = code;
      return this;
    },
    end() {
      this.headersSent = true;
      return this;
    }
  };
  await receiveShopifyWebhook({ body: raw, get: name => headers[name.toLowerCase()] }, res);
  return result.code;
};

test('a correctly signed webhook brings the new orders in; a wrong signature or an unknown store is refused alike', async () => {
  fakeShopify({ orders: [orderNode({ number: 51486 })] });

  assert.equal(await webhook({ signature: 'not-the-signature' }), 401);
  assert.equal(await webhook({ secret: 'another-secret-entirely' }), 401);
  assert.equal(await webhook({ shop: 'nobody.myshopify.com' }), 401);
  assert.equal(
    await Order.countDocuments({ business: biz._id }),
    0,
    'nothing happened for a refused call'
  );

  assert.equal(await webhook({}), 200);
  assert.equal(await Order.countDocuments({ business: biz._id }), 1);
  assert.equal((await ShopifyConnection.findById(connection._id)).webhookActive, true);
});

test('the webhook does not trust its own body: a tampered body with the old signature is refused', async () => {
  const raw = '{"id":1}';
  const sig = crypto.createHmac('sha256', SECRET).update(Buffer.from(raw)).digest('base64');
  assert.equal(await webhook({ body: '{"id":2}', signature: sig }), 401);
});

// ── matching a line to stock ─────────────────────────────────────────────────

const lineOf = extra => ({
  title: 'BEIGE MEHFIL',
  variantTitle: 'M',
  sku: '',
  quantity: 1,
  originalUnitPriceSet: { shopMoney: { amount: '16000' } },
  variant: { id: 'gid://shopify/ProductVariant/501' },
  product: { id: 'gid://shopify/Product/501' },
  ...extra
});

test('look-alike dashes, extra spaces and capitals in a name do not stop the match', async () => {
  await Product.updateOne({ _id: product._id }, { $set: { name: 'Noor-e-Ain' } });
  const out = await importOrder(
    connection,
    orderNode({ number: 51490, lines: [lineOf({ title: ' noor–e–ain ', variantTitle: 'M' })] }),
    actor
  );
  assert.equal(out.result, 'created');
});

test('a barcode in the Shopify SKU matches exactly, whatever the names say', async () => {
  const variantL = (await Product.findById(product._id)).variants.find(v => v.label === 'L');
  const barcode = variantL.barcode;
  const out = await importOrder(
    connection,
    orderNode({
      number: 51491,
      lines: [lineOf({ title: 'Something else', variantTitle: 'XS', sku: barcode })]
    }),
    actor
  );
  assert.equal(out.result, 'created');
  assert.equal(
    String((await Order.findById(out.orderId)).items[0].variantId),
    String(variantL._id)
  );
});

test('a held order says why: no such item, two with the name, or no such size', async () => {
  const none = await importOrder(
    connection,
    orderNode({ number: 51492, lines: [lineOf({ title: 'Nothing like it' })] }),
    actor
  );
  assert.equal(none.result, 'held');

  const noSize = await importOrder(
    connection,
    orderNode({ number: 51493, lines: [lineOf({ variantTitle: 'XS' })] }),
    actor
  );
  assert.equal(noSize.result, 'held');

  await Product.create({
    business: biz._id,
    category: oid(),
    name: 'Beige Mehfil',
    createdBy: userId,
    variants: [{ label: 'M', costPrice: 0, salePrice: 1, stock: 1 }]
  });
  const twice = await importOrder(connection, orderNode({ number: 51494 }), actor);
  assert.equal(twice.result, 'held');

  const reasonsOf = async n =>
    (await ShopifyHold.findOne({ business: biz._id, shopifyOrderId: String(n) })).reasons.join(
      ' | '
    );
  assert.match(await reasonsOf(51492), /no stock item is named "Nothing like it"/);
  assert.match(await reasonsOf(51493), /has no size "XS" in stock/);
  assert.match(await reasonsOf(51494), /2 stock items are named/);
});
