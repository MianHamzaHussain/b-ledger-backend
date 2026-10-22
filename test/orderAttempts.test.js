import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  connect,
  clear,
  disconnect,
  makeBusiness,
  makeProduct,
  makeParty,
  runHandler,
  oid,
  userId
} from './helpers/db.js';
import Order from '../models/Order.js';
import { updateOrderStatus, addDeliveryAttempt } from '../controllers/orderController.js';
import { orderAttemptSchema, orderStatusSchema } from '../schemas/orders.js';

/**
 * A failed try at the door is logged on a parcel that is still out. It changes
 * no status; it only lets the courier report tell "delivered first time" from
 * "took several tries" — and only for parcels sent after this existed.
 */

before(connect);
after(disconnect);
afterEach(clear);

/** An order in a business — a second order can join the first's business via `ctx`. */
async function makeOrder(ctx) {
  const biz = ctx?.biz || (await makeBusiness());
  const courier = ctx?.courier || (await makeParty(biz._id, 'courier'));
  const product = ctx?.product || (await makeProduct(biz._id));
  const order = await Order.create({
    business: biz._id,
    customer: oid(),
    customerName: 'Ali',
    contactNumber: '03001234567',
    items: [
      {
        product: product._id,
        variantId: product.variants[0]._id,
        productName: product.name,
        quantity: 1,
        unitPrice: 2000,
        unitCost: 1000
      }
    ],
    createdBy: userId
  });
  return { biz, courier, product, order };
}

const setStatus = (order, body) =>
  runHandler(updateOrderStatus, { resource: order, body: orderStatusSchema.parse(body) });

const attempt = (order, body) =>
  runHandler(addDeliveryAttempt, { resource: order, body: orderAttemptSchema.parse(body) });

const dispatch = async ctx => {
  const made = await makeOrder(ctx);
  await setStatus(made.order, {
    status: 'dispatched',
    courier: String(made.courier._id),
    trackingId: 'T1'
  });
  return made.order;
};

test('dispatching marks the parcel as one whose attempts are tracked', async () => {
  const { courier, order } = await makeOrder();
  assert.equal(order.attemptsTracked, false);

  await setStatus(order, { status: 'dispatched', courier: String(courier._id), trackingId: 'T1' });
  assert.equal((await Order.findById(order._id)).attemptsTracked, true);
});

test('a failed attempt is logged on a dispatched parcel and changes no status', async () => {
  const order = await dispatch();
  const historyBefore = (await Order.findById(order._id)).statusHistory.length;

  const { status, body } = await attempt(order, { reason: 'not-available', note: 'Phone off' });
  assert.equal(status, 201);

  const saved = await Order.findById(order._id);
  assert.equal(saved.status, 'dispatched');
  assert.equal(saved.statusHistory.length, historyBefore);
  assert.equal(saved.deliveryAttempts.length, 1);
  assert.equal(saved.deliveryAttempts[0].reason, 'not-available');
  assert.equal(saved.deliveryAttempts[0].note, 'Phone off');
  assert.equal(body.data.deliveryAttempts.length, 1);
});

test('attempts add up, one per call', async () => {
  const order = await dispatch();
  await attempt(order, { reason: 'unreachable' });
  await attempt(order, { reason: 'wrong-address' });
  assert.equal((await Order.findById(order._id)).deliveryAttempts.length, 2);
});

test('only a dispatched parcel can have a failed attempt', async () => {
  const first = await makeOrder();
  await assert.rejects(attempt(first.order, { reason: 'refused' }), /Only a dispatched parcel/);

  const out = await dispatch(first);
  await setStatus(out, { status: 'delivered' });
  await assert.rejects(attempt(out, { reason: 'refused' }), /Only a dispatched parcel/);
});

test('an unknown reason is refused by the schema', () => {
  assert.equal(orderAttemptSchema.safeParse({ reason: 'bored' }).success, false);
  assert.equal(orderAttemptSchema.safeParse({}).success, false);
  assert.equal(
    orderAttemptSchema.safeParse({ reason: 'other', note: 'x'.repeat(201) }).success,
    false
  );
});

test('who and when come from the server, never the request body', async () => {
  const order = await dispatch();
  const forged = oid();
  // The schema strips unknown keys, so a forged `by`/`at` never reaches the controller.
  const body = orderAttemptSchema.parse({ reason: 'refused', by: forged, at: '2000-01-01' });
  assert.equal('by' in body, false);
  assert.equal('at' in body, false);

  await runHandler(addDeliveryAttempt, { resource: order, body });
  const [logged] = (await Order.findById(order._id)).deliveryAttempts;
  assert.equal(String(logged.by), String(userId));
  assert.ok(Date.now() - logged.at.getTime() < 60_000, 'stamped now');
});
