import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect } from './helpers/db.js';
import Order from '../models/Order.js';
import Notification from '../models/Notification.js';
import { clearCityCache } from '../utils/couriers/booking.js';
import { readStatus, attemptReason, runCourierSync } from '../utils/courierSync.js';
import { fakePostex, restoreFetch, setupOrder, dispatchBooked } from './helpers/courier.js';

/**
 * The status check asks PostEx where each booked parcel is. It records the journey and failed tries,
 * and when PostEx says delivered or returned it only MARKS the order "ready to confirm" — it never
 * moves the order itself, because those steps post sales, cost and stock.
 */
before(connect);
after(disconnect);
afterEach(async () => {
  restoreFetch();
  clearCityCache();
  await clear();
});

const hist = (...codes) =>
  codes.map(([code, message]) => ({
    transactionStatusMessageCode: code,
    transactionStatusMessage: message
  }));

/** A dispatched, booked order whose PostEx record (tracking CX-1001) we control. */
const booked = async (record, opts) => {
  const postex = fakePostex({});
  const made = await setupOrder(opts);
  await dispatchBooked(made.order, made.courier);
  const tracking = { 'CX-1001': record };
  fakePostex({ tracking, failBulk: opts?.failBulk });
  return { ...made, postex, tracking };
};

test('what the courier’s words mean', () => {
  assert.equal(readStatus({ status: 'Delivered', history: [] }), 'delivered');
  assert.equal(readStatus({ status: 'Returned', history: [] }), 'returned');
  assert.equal(readStatus({ status: 'Attempted', history: [] }), 'attempted');
  for (const s of [
    'Out For Delivery',
    'Booked',
    'PostEx WareHouse',
    'Out For Return',
    'Picked By PostEx'
  ]) {
    assert.equal(readStatus({ status: s, history: [] }), 'moving', s);
  }
  // No status text: the last message code decides.
  assert.equal(readStatus({ status: '', history: [{ code: '0005' }] }), 'delivered');
  assert.equal(readStatus({ status: '', history: [{ code: '0007' }] }), 'returned');
});

test('a failed try is filed under our reasons, in the courier’s words', () => {
  assert.equal(attemptReason('Customer not available'), 'not-available');
  assert.equal(attemptReason('Customer refused to accept'), 'refused');
  assert.equal(attemptReason('Incomplete address'), 'wrong-address');
  assert.equal(attemptReason('Phone switched off, unreachable'), 'unreachable');
  assert.equal(attemptReason('Rain'), 'other');
});

test('a parcel on its way: the status is saved and the order is left alone', async () => {
  const { order } = await booked({
    transactionStatus: 'Out For Delivery',
    transactionStatusHistory: hist(['0004', 'Package on Root'])
  });
  const tally = await runCourierSync();
  assert.equal(tally.checked, 1);

  const fresh = await Order.findById(order._id);
  assert.equal(fresh.status, 'dispatched');
  assert.equal(fresh.courierBooking.courierStatus, 'Out For Delivery');
  assert.equal(fresh.courierBooking.confirmable, undefined);
  assert.ok(fresh.courierBooking.lastSyncAt);
  assert.equal(fresh.courierBooking.history[0].code, '0004');
});

test('a failed try is logged once, with the courier’s reason, however often it is checked', async () => {
  const { order } = await booked({
    transactionStatus: 'Attempted',
    transactionStatusHistory: hist(['0013', 'Attempt Made: Customer not available'])
  });
  await runCourierSync();
  await runCourierSync();
  const fresh = await Order.findById(order._id);
  assert.equal(fresh.deliveryAttempts.length, 1);
  assert.equal(fresh.deliveryAttempts[0].reason, 'not-available');
  assert.equal(fresh.deliveryAttempts[0].note, 'PostEx: Customer not available');
  assert.equal(fresh.deliveryAttempts[0].by, undefined, 'no person — it came from the courier');
});

test('a second failed try adds one more, not two', async () => {
  const { order, tracking } = await booked({
    transactionStatus: 'Attempted',
    transactionStatusHistory: hist(['0013', 'Attempt Made: Customer not available'])
  });
  await runCourierSync();
  tracking['CX-1001'] = {
    transactionStatus: 'Attempted',
    transactionStatusHistory: hist(
      ['0013', 'Attempt Made: Customer not available'],
      ['0013', 'Attempt Made: Wrong address']
    )
  };
  await runCourierSync();
  const attempts = (await Order.findById(order._id)).deliveryAttempts;
  assert.deepEqual(
    attempts.map(a => a.reason),
    ['not-available', 'wrong-address']
  );
});

test('delivered: the order is only marked ready to confirm, with the courier’s fee, and people are told once', async () => {
  const { order } = await booked({
    transactionStatus: 'Delivered',
    transactionFee: 180,
    transactionTax: 29,
    transactionStatusHistory: hist(['0005', 'Delivered'])
  });
  await runCourierSync();
  await runCourierSync();

  const fresh = await Order.findById(order._id);
  assert.equal(fresh.status, 'dispatched', 'the sync never moves the order itself');
  assert.equal(fresh.courierBooking.confirmable, 'delivered');
  assert.equal(fresh.courierBooking.fee, 180);
  assert.equal(fresh.courierBooking.tax, 29);
  assert.equal(await Notification.countDocuments({ type: 'courier-ready' }), 1);
  const note = await Notification.findOne({ type: 'courier-ready' });
  assert.match(note.title, /Delivered, says PostEx/);
  assert.equal(note.link, `/orders/${order._id}`);
});

test('returned: ready to confirm, with the return fee', async () => {
  const { order } = await booked({
    transactionStatus: 'Returned',
    reversalFee: 120,
    reversalTax: 19,
    transactionStatusHistory: hist(['0006', 'Returned'])
  });
  await runCourierSync();
  const fresh = await Order.findById(order._id);
  assert.equal(fresh.courierBooking.confirmable, 'returned');
  assert.equal(fresh.courierBooking.fee, 120);
  assert.equal(fresh.status, 'dispatched');
});

test('if PostEx takes "delivered" back, the mark is removed', async () => {
  const { order, tracking } = await booked({
    transactionStatus: 'Delivered',
    transactionStatusHistory: hist(['0005', 'Delivered'])
  });
  await runCourierSync();
  assert.equal((await Order.findById(order._id)).courierBooking.confirmable, 'delivered');

  tracking['CX-1001'] = {
    transactionStatus: 'Attempted',
    transactionStatusHistory: hist(['0013', 'Attempt Made: Refused'])
  };
  await runCourierSync();
  assert.equal((await Order.findById(order._id)).courierBooking.confirmable, undefined);
});

test('one parcel PostEx can not find does not stop the others', async () => {
  const postex = fakePostex({});
  const a = await setupOrder({ name: 'First' });
  await dispatchBooked(a.order, a.courier); // CX-1001
  const b = await setupOrder({ name: 'Second' });
  await dispatchBooked(b.order, b.courier); // CX-1001 again — a fresh fake counts from 1
  void postex;
  // Both orders hold CX-1001 here; make the second a different number by hand.
  await Order.updateOne({ _id: b.order._id }, { 'courierBooking.trackingNumber': 'CX-2002' });
  fakePostex({ tracking: { 'CX-1001': { transactionStatus: 'Out For Delivery' } } }); // CX-2002 unknown
  const tally = await runCourierSync();
  assert.equal(tally.checked, 2);
  assert.equal(
    (await Order.findById(a.order._id)).courierBooking.courierStatus,
    'Out For Delivery'
  );
  assert.equal((await Order.findById(b.order._id)).courierBooking.courierStatus, 'UnBooked');
});

test('if the bulk call fails, parcels are asked for one at a time', async () => {
  const { order } = await booked({ transactionStatus: 'Out For Delivery' }, { failBulk: true });
  await runCourierSync();
  assert.equal((await Order.findById(order._id)).courierBooking.courierStatus, 'Out For Delivery');
});

test('orders that were not booked through a courier are never asked about', async () => {
  const { order, courier } = await setupOrder();
  fakePostex({});
  await dispatchBooked(order, courier, { bookWithCourier: false, trackingId: 'TCS-9' });
  const { calls } = fakePostex({});
  const tally = await runCourierSync();
  assert.equal(tally.checked, 0);
  assert.equal(calls.filter(u => u.includes('track')).length, 0);
});

test('a courier that was disconnected is skipped without stopping the run', async () => {
  const { order, courier } = await booked({ transactionStatus: 'Out For Delivery' });
  const { default: Party } = await import('../models/Party.js');
  await Party.updateOne({ _id: courier._id }, { $unset: { integration: 1 } });
  const tally = await runCourierSync();
  assert.equal(tally.errors, 1);
  assert.equal((await Order.findById(order._id)).courierBooking.courierStatus, 'UnBooked');
});
