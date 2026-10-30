import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, runHandler } from './helpers/db.js';
import Order from '../models/Order.js';
import Party from '../models/Party.js';
import { updateOrderStatus } from '../controllers/orderController.js';
import { saveConnection } from '../controllers/courierConnectionController.js';
import { orderStatusSchema } from '../schemas/orders.js';
import { courierConnectionSchema } from '../schemas/parties.js';
import { clearCityCache } from '../utils/couriers/booking.js';
import { adoptTypedParcels, judgeParcel } from '../utils/couriers/adopt.js';
import { runCourierSync } from '../utils/courierSync.js';
import { admin, fakePostex, restoreFetch, setupOrder } from './helpers/courier.js';
import { REFUSED_AND_RETURNING } from './fixtures/postexTracks.js';

/**
 * A tracking number typed in by hand is taken over only when it is clearly the same parcel: the courier knows
 * it, no other order has it, it is typed on one order, the amount matches and the phone (when sent) matches.
 */
before(connect);
after(disconnect);
afterEach(async () => {
  restoreFetch();
  clearCityCache();
  await clear();
});

/** What PostEx answers for a parcel of this order: the order's own amount and phone, in PostEx's shape. */
// The fixture's own tracking number is dropped: the fake answers under the number that was asked about.
const { trackingNumber: _own, ...JOURNEY } = REFUSED_AND_RETURNING; // eslint-disable-line no-unused-vars
const parcelOf = (order, extra = {}) => ({
  ...JOURNEY,
  invoicePayment: order.codAmount,
  customerPhone: '03001234567',
  ...extra
});

/** Dispatch the order the old way: a person types the number, nothing is booked. */
const dispatchTyped = async (order, courier, number) => {
  await runHandler(updateOrderStatus, {
    user: admin,
    resource: order,
    body: orderStatusSchema.parse({
      status: 'dispatched',
      courier: String(courier._id),
      trackingId: number
    })
  });
  return Order.findById(order._id);
};

test('a typed number PostEx knows, with the same amount and phone, is followed from then on', async () => {
  const { order, courier } = await setupOrder();
  fakePostex({ tracking: { TYPED1: parcelOf(order) } });
  const typed = await dispatchTyped(order, courier, 'TYPED1');
  assert.equal(typed.courierBooking?.trackingNumber, undefined, 'typed in, not booked');

  const out = await runCourierSync();

  assert.equal(out.adopted, 1);
  const after1 = await Order.findById(order._id);
  assert.equal(after1.courierBooking.trackingNumber, 'TYPED1');
  assert.equal(after1.courierBooking.provider, 'postex');
  assert.equal(after1.courierBooking.phase, 'returning', 'the same pass already read its stage');
  assert.equal(after1.attemptsTracked, true);
  assert.equal(after1.adoptTry, undefined);
  assert.ok(
    after1.activity.some(a => a.system && /started following/.test(a.text)),
    'the timeline says the app took it over'
  );
});

test('a number PostEx does not know is left alone, with the reason kept and not retried within the hour', async () => {
  const { order, courier } = await setupOrder();
  const { calls } = fakePostex({ tracking: {} });
  await dispatchTyped(order, courier, 'NOPE');

  const first = await adoptTypedParcels();
  assert.equal(first.adopted, 0);
  const o = await Order.findById(order._id);
  assert.equal(o.courierBooking?.trackingNumber, undefined);
  assert.match(o.adoptTry.reason, /does not know/);

  const asked = calls.length;
  await adoptTypedParcels();
  assert.equal(calls.length, asked, 'not asked again within the hour');
});

test('a different amount is not taken over — a person looks at it', async () => {
  const { order, courier } = await setupOrder();
  fakePostex({ tracking: { TYPED2: parcelOf(order, { invoicePayment: order.codAmount + 500 }) } });
  await dispatchTyped(order, courier, 'TYPED2');

  assert.equal((await adoptTypedParcels()).adopted, 0);
  assert.match((await Order.findById(order._id)).adoptTry.reason, /amount/);
});

test('a different phone is not taken over', async () => {
  const { order, courier } = await setupOrder();
  fakePostex({ tracking: { TYPED3: parcelOf(order, { customerPhone: '03331112222' }) } });
  await dispatchTyped(order, courier, 'TYPED3');

  assert.equal((await adoptTypedParcels()).adopted, 0);
  assert.match((await Order.findById(order._id)).adoptTry.reason, /phone/);
});

test('a parcel already attached to another order is never taken twice', async () => {
  const a = await setupOrder();
  fakePostex({ tracking: { SAME: parcelOf(a.order) } });
  await dispatchTyped(a.order, a.courier, 'SAME');
  assert.equal((await adoptTypedParcels()).adopted, 1);

  // A second order of the same business has the same number typed in.
  const b = await setupOrder();
  await Order.updateOne(
    { _id: b.order._id },
    {
      $set: {
        business: a.order.business,
        courier: a.courier._id,
        status: 'dispatched',
        trackingId: 'SAME'
      }
    }
  );
  assert.equal((await adoptTypedParcels()).adopted, 0);
  assert.match((await Order.findById(b.order._id)).adoptTry.reason, /already attached/);
});

test('one number typed on two orders is taken over on neither', async () => {
  const a = await setupOrder();
  fakePostex({ tracking: { TWICE: parcelOf(a.order) } });
  await dispatchTyped(a.order, a.courier, 'TWICE');
  const b = await setupOrder();
  await Order.updateOne(
    { _id: b.order._id },
    {
      $set: {
        courier: a.courier._id,
        business: a.order.business,
        status: 'dispatched',
        trackingId: 'TWICE'
      }
    }
  );

  assert.equal((await adoptTypedParcels()).adopted, 0);
  assert.match((await Order.findById(a.order._id)).adoptTry.reason, /more than one order/);
});

test('a courier with "take over typed numbers" switched off is never asked', async () => {
  const { order, courier } = await setupOrder();
  const { calls } = fakePostex({ tracking: { OFF1: parcelOf(order) } });
  await dispatchTyped(order, courier, 'OFF1');
  await runHandler(saveConnection, {
    user: admin,
    resource: await Party.findById(courier._id),
    body: courierConnectionSchema.parse({ adoptTyped: false })
  });
  const asked = calls.length;

  assert.equal((await adoptTypedParcels()).adopted, 0);
  assert.equal(calls.length, asked);
  assert.equal((await Order.findById(order._id)).adoptTry, undefined);
});

test('an order that is not dispatched, or has no number, is not looked at', async () => {
  const { order } = await setupOrder();
  fakePostex({ tracking: {} });
  assert.equal((await adoptTypedParcels()).checked, 0);
  assert.equal(order.trackingId, undefined);
});

test('the same judgement without the database: amount may match the COD or the total', () => {
  const order = { codAmount: 3500, total: 4000, contactNumber: '0300 1234567 / 0333 1112222' };
  const parcel = { trackingNumber: 'X', invoicePayment: 4000, customerPhone: '03331112222' };
  assert.equal(judgeParcel(order, parcel).ok, true, 'total when an advance was taken');
  assert.equal(judgeParcel(order, { ...parcel, invoicePayment: 3500 }).ok, true);
  assert.equal(
    judgeParcel(order, { ...parcel, customerPhone: undefined }).ok,
    true,
    'no phone sent'
  );
  assert.equal(judgeParcel(order, null).ok, false);
});
