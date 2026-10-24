import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, makeBusiness, makeProduct, runHandler } from './helpers/db.js';
import Order from '../models/Order.js';
import {
  createOrder,
  updateOrder,
  updateOrderCustomerNote,
  updateOrderNote
} from '../controllers/orderController.js';
import {
  orderCreateSchema,
  orderUpdateSchema,
  orderCustomerNoteSchema,
  orderNoteSchema
} from '../schemas/orders.js';

/**
 * An order carries two kinds of note. The customer's request is taken with the order
 * ("gift pack") and is `customerNote`; what the team writes afterwards about courier,
 * dispatch or return is `note`, shown as the "Reason". They are separate fields, each
 * editable at any status, and neither touches the other.
 */

before(connect);
after(disconnect);
afterEach(clear);

async function setup() {
  const biz = await makeBusiness();
  const product = await makeProduct(biz._id);
  return { biz, product };
}

const body = (ctx, extra = {}) => ({
  business: String(ctx.biz._id),
  customerName: 'Sana',
  contactNumber: '03004445555',
  items: [
    {
      product: String(ctx.product._id),
      variantId: String(ctx.product.variants[0]._id),
      quantity: 1,
      unitPrice: 3000
    }
  ],
  ...extra
});

const place = async (ctx, extra) => {
  const out = await runHandler(createOrder, {
    body: orderCreateSchema.parse(body(ctx, extra))
  });
  return Order.findById(out.body.data._id);
};

test('the customer’s request is stored with the order, trimmed', async () => {
  const ctx = await setup();
  const order = await place(ctx, { customerNote: '  Gift pack, call before delivery ' });
  assert.equal(order.customerNote, 'Gift pack, call before delivery');
  assert.equal(order.note, undefined, 'the Reason is a separate field and stays empty');
});

test('an order needs no customer note', async () => {
  const ctx = await setup();
  assert.equal((await place(ctx)).customerNote, undefined);
  assert.equal((await place(ctx, { customerNote: '   ' })).customerNote, undefined);
});

test('the customer note can be changed and cleared, and leaves the Reason alone', async () => {
  const ctx = await setup();
  const order = await place(ctx, { customerNote: 'Gift pack' });
  await runHandler(updateOrderNote, {
    resource: order,
    body: orderNoteSchema.parse({ note: 'Handed to TCS' })
  });

  const changed = (
    await runHandler(updateOrderCustomerNote, {
      resource: await Order.findById(order._id),
      body: orderCustomerNoteSchema.parse({ customerNote: ' Gift pack + card ' })
    })
  ).body.data;
  assert.equal(changed.customerNote, 'Gift pack + card');
  assert.equal(changed.note, 'Handed to TCS');

  const cleared = (
    await runHandler(updateOrderCustomerNote, {
      resource: await Order.findById(order._id),
      body: orderCustomerNoteSchema.parse({ customerNote: '' })
    })
  ).body.data;
  assert.ok(!cleared.customerNote);
  assert.equal(cleared.note, 'Handed to TCS');
});

test('editing the order’s items keeps the customer note', async () => {
  const ctx = await setup();
  const order = await place(ctx, { customerNote: 'Gift pack' });
  await runHandler(updateOrder, {
    resource: await Order.findById(order._id),
    body: orderUpdateSchema.parse(body(ctx, { customerName: 'Sana K' }))
  });
  assert.equal((await Order.findById(order._id)).customerNote, 'Gift pack');
});

test('a customer note over 500 characters is refused, 500 is fine', () => {
  const create = customerNote =>
    orderCreateSchema.safeParse(
      body({ biz: { _id: 'b' }, product: { _id: 'p', variants: [{ _id: 'v' }] } }, { customerNote })
    );
  assert.equal(create('x'.repeat(500)).success, true);
  assert.equal(create('x'.repeat(501)).success, false);
  assert.equal(orderCustomerNoteSchema.safeParse({ customerNote: 'x'.repeat(501) }).success, false);
  assert.equal(orderCustomerNoteSchema.safeParse({ customerNote: '' }).success, true);
  assert.equal(orderCustomerNoteSchema.safeParse({}).success, false, 'a note must be sent');
});
