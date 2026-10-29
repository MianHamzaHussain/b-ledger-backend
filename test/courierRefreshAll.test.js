import { test, before, after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, runHandler } from './helpers/db.js';
import Order from '../models/Order.js';
import { clearCityCache } from '../utils/couriers/booking.js';
import { clearRefreshAllCooldown, runCourierSync } from '../utils/courierSync.js';
import { refreshAllCouriers } from '../controllers/orderController.js';
import { orderRefreshAllSchema } from '../schemas/orders.js';
import { admin, dispatchBooked, fakePostex, restoreFetch, setupOrder } from './helpers/courier.js';
import { DELIVERED, REFUSED_AND_RETURNING } from './fixtures/postexTracks.js';

/**
 * "Refresh all" (R10): the 10-minute check, now, for one business — only that business's parcels, once a
 * minute, and never as one of the two matching checks an automatic confirm waits for.
 */
before(connect);
after(disconnect);
beforeEach(clearRefreshAllCooldown);
afterEach(async () => {
  restoreFetch();
  clearCityCache();
  await clear();
});

/** Two businesses, each with one parcel booked as CX-1001; the courier then answers with `record`. */
const twoBusinesses = async record => {
  fakePostex({});
  const a = await setupOrder();
  await dispatchBooked(a.order, a.courier);
  const b = await setupOrder();
  await dispatchBooked(b.order, b.courier);
  fakePostex({ tracking: { 'CX-1001': { ...record, trackingNumber: 'CX-1001' } } });
  return { a, b };
};

const call = business =>
  runHandler(refreshAllCouriers, {
    user: admin,
    body: orderRefreshAllSchema.parse({ business: String(business) })
  });

test('it checks only the business asked for, and says how many it checked and changed', async () => {
  const { a, b } = await twoBusinesses(REFUSED_AND_RETURNING);
  const out = await call(a.order.business);

  assert.deepEqual(out.body.data, { checked: 1, updated: 1, errors: 0 });
  assert.equal((await Order.findById(a.order._id)).courierBooking.phase, 'returning');
  const untouched = await Order.findById(b.order._id);
  assert.equal(
    untouched.courierBooking.lastSyncAt,
    undefined,
    'the other business is never asked about'
  );
});

test('a second tap within a minute is refused with the seconds to wait, per business', async () => {
  const { a, b } = await twoBusinesses(REFUSED_AND_RETURNING);
  await call(a.order.business);

  await assert.rejects(
    () => call(a.order.business),
    err => {
      assert.equal(err.statusCode, 429);
      assert.match(err.message, /Checked a moment ago — try again in \d+ seconds/);
      return true;
    }
  );
  // Another business has its own minute.
  const other = await call(b.order.business);
  assert.equal(other.body.data.checked, 1);
});

test('it never counts as one of the two matching checks an automatic confirm waits for', async () => {
  const { a } = await twoBusinesses(DELIVERED);
  await call(a.order.business);
  const after1 = await Order.findById(a.order._id);
  assert.equal(after1.courierBooking.confirmable, 'delivered', 'it is ready to confirm…');
  assert.equal(after1.courierBooking.seenCount, undefined, '…but the check was not counted');

  await runCourierSync();
  assert.equal(
    (await Order.findById(a.order._id)).courierBooking.seenCount,
    1,
    'the real pass counts'
  );
});

test('the business must be named', () => {
  assert.throws(() => orderRefreshAllSchema.parse({}), /Required|business/i);
});
