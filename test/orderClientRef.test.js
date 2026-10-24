import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, makeBusiness, makeProduct, runHandler } from './helpers/db.js';
import Order from '../models/Order.js';
import Product from '../models/Product.js';
import { createOrder } from '../controllers/orderController.js';
import { orderCreateSchema } from '../schemas/orders.js';

/**
 * An order made on a phone with a poor connection may be sent twice — a double tap, a
 * retry, an offline draft sent again. Each order carries a reference the app made up;
 * sending the same one again returns the order already made, so there is one order and
 * one stock reservation, never two.
 */

before(async () => {
  await connect();
  // The unique index is what settles two sends racing each other.
  await Order.init();
});
after(disconnect);
afterEach(clear);

async function setup() {
  const biz = await makeBusiness();
  const product = await makeProduct(biz._id);
  return { biz, product };
}

const send = (ctx, extra = {}, business = ctx.biz) =>
  runHandler(createOrder, {
    body: orderCreateSchema.parse({
      business: String(business._id),
      customerName: 'Sana',
      contactNumber: '03004445555',
      items: [
        {
          product: String(ctx.product._id),
          variantId: String(ctx.product.variants[0]._id),
          quantity: 2,
          unitPrice: 3000
        }
      ],
      ...extra
    })
  });

const stockOf = async ctx => (await Product.findById(ctx.product._id)).variants[0].stock;

test('the first send makes the order (201) and keeps its reference', async () => {
  const ctx = await setup();
  const first = await send(ctx, { clientRef: 'draft-1' });
  assert.equal(first.status, 201);
  assert.equal((await Order.findById(first.body.data._id)).clientRef, 'draft-1');
});

test('sending the same reference again returns the same order — one order, one reservation', async () => {
  const ctx = await setup();
  const first = await send(ctx, { clientRef: 'draft-1' });
  const stockAfterFirst = await stockOf(ctx);

  const again = await send(ctx, { clientRef: 'draft-1' });
  assert.equal(again.status, 200, 'not 201: nothing was created');
  assert.equal(String(again.body.data._id), String(first.body.data._id));
  assert.equal(again.body.data.orderNumber, first.body.data.orderNumber);
  assert.equal(await Order.countDocuments(), 1);
  assert.equal(await stockOf(ctx), stockAfterFirst, 'stock was taken once');
});

test('a resend still answers after the order has moved on', async () => {
  const ctx = await setup();
  const first = await send(ctx, { clientRef: 'draft-1' });
  await Order.updateOne({ _id: first.body.data._id }, { status: 'dispatched' });
  const again = await send(ctx, { clientRef: 'draft-1' });
  assert.equal(again.status, 200);
  assert.equal(again.body.data.status, 'dispatched');
  assert.equal(await Order.countDocuments(), 1);
});

test('two sends at the same moment make one order and take stock once', async () => {
  const ctx = await setup();
  const before = await stockOf(ctx);
  const results = await Promise.allSettled([
    send(ctx, { clientRef: 'draft-race' }),
    send(ctx, { clientRef: 'draft-race' })
  ]);
  assert.deepEqual(
    results.map(r => r.status),
    ['fulfilled', 'fulfilled'],
    'neither send is an error'
  );
  const ids = new Set(results.map(r => String(r.value.body.data._id)));
  assert.equal(ids.size, 1, 'both answers are the same order');
  assert.equal(await Order.countDocuments(), 1);
  assert.equal(await stockOf(ctx), before - 2, 'two pieces taken, not four');
});

test('different references, or none, are different orders', async () => {
  const ctx = await setup();
  await send(ctx, { clientRef: 'a' });
  await send(ctx, { clientRef: 'b' });
  await send(ctx);
  await send(ctx);
  assert.equal(await Order.countDocuments(), 4, 'orders with no reference never collide');
});

test('the same reference in two businesses is two orders', async () => {
  const ctx = await setup();
  const other = await makeBusiness({ name: 'Other Biz' });
  const product2 = await makeProduct(other._id);
  await send(ctx, { clientRef: 'same' });
  const second = await send({ ...ctx, product: product2 }, { clientRef: 'same' }, other);
  assert.equal(second.status, 201);
  assert.equal(await Order.countDocuments(), 2);
});

test('a reference must be a short non-empty string', () => {
  const parse = clientRef =>
    orderCreateSchema.safeParse({
      business: 'b',
      customerName: 'S',
      contactNumber: '1',
      items: [{ product: 'p', variantId: 'v', quantity: 1, unitPrice: 1 }],
      clientRef
    }).success;
  assert.equal(parse('3f2b8c1e-0000-4000-8000-000000000000'), true);
  assert.equal(parse(undefined), true);
  assert.equal(parse(''), false);
  assert.equal(parse('x'.repeat(65)), false);
});
