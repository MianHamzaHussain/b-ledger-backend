import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  connect,
  clear,
  disconnect,
  makeBusiness,
  makeProduct,
  runHandler,
  userId
} from './helpers/db.js';
import Order from '../models/Order.js';
import '../models/Category.js';
import { createOrder, updateOrderShopifyNumber } from '../controllers/orderController.js';
import { orderCreateSchema, orderShopifyNumberSchema } from '../schemas/orders.js';
import { cleanShopifyNumber } from '../utils/shopifyNumber.js';

/**
 * The Shopify store numbers its orders its own way. We keep that number on the order as a plain
 * reference so the two series can be traced to each other — it never changes our numbering.
 */
before(connect);
after(disconnect);
afterEach(clear);

const admin = { id: userId, role: { fullAccess: true } };

test('the number is cleaned the way people copy it', () => {
  assert.equal(cleanShopifyNumber('#12,355'), '12355');
  assert.equal(cleanShopifyNumber(' 12 355 '), '12355');
  assert.equal(cleanShopifyNumber('LX-1042'), 'LX-1042');
  assert.equal(cleanShopifyNumber(''), '');
});

const place = async (extra = {}) => {
  const biz = await makeBusiness();
  const product = await makeProduct(biz._id);
  const out = await runHandler(createOrder, {
    user: admin,
    body: orderCreateSchema.parse({
      business: String(biz._id),
      customerName: 'Sana',
      contactNumber: '03004445555',
      source: 'shopify',
      items: [
        {
          product: String(product._id),
          variantId: String(product.variants[0]._id),
          quantity: 1,
          unitPrice: 2000
        }
      ],
      ...extra
    })
  });
  return Order.findById(out.body.data._id);
};

test('an order can carry the Shopify number, saved cleaned', async () => {
  const order = await place({ shopifyOrderNumber: '#12,355' });
  assert.equal(order.shopifyOrderNumber, '12355');
  assert.ok(order.orderNumber, 'our own number is unchanged');
});

test('an order without one simply has none', async () => {
  const order = await place();
  assert.equal(order.shopifyOrderNumber, undefined);
});

test('it can be changed or cleared at any status, even after dispatch', async () => {
  const order = await place({ shopifyOrderNumber: '12355' });
  await Order.updateOne({ _id: order._id }, { status: 'dispatched' });

  const fix = await runHandler(updateOrderShopifyNumber, {
    user: admin,
    resource: await Order.findById(order._id),
    body: orderShopifyNumberSchema.parse({ shopifyOrderNumber: '#12356' })
  });
  assert.equal(fix.body.data.shopifyOrderNumber, '12356');

  await runHandler(updateOrderShopifyNumber, {
    user: admin,
    resource: await Order.findById(order._id),
    body: orderShopifyNumberSchema.parse({ shopifyOrderNumber: '' })
  });
  assert.equal((await Order.findById(order._id)).shopifyOrderNumber, undefined);
});

test('the same number may be used twice — a cancelled order is re-entered', async () => {
  const biz = await makeBusiness();
  const product = await makeProduct(biz._id);
  const body = () =>
    orderCreateSchema.parse({
      business: String(biz._id),
      customerName: 'Sana',
      contactNumber: '03004445555',
      shopifyOrderNumber: '12355',
      items: [
        {
          product: String(product._id),
          variantId: String(product.variants[0]._id),
          quantity: 1,
          unitPrice: 2000
        }
      ]
    });
  await runHandler(createOrder, { user: admin, body: body() });
  const second = await runHandler(createOrder, { user: admin, body: body() });
  assert.equal(second.status, 201);
});

test('a number that is far too long is refused', () => {
  assert.equal(
    orderShopifyNumberSchema.safeParse({ shopifyOrderNumber: '1'.repeat(41) }).success,
    false
  );
});
