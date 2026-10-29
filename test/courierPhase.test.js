import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect } from './helpers/db.js';
import Order from '../models/Order.js';
import Notification from '../models/Notification.js';
import { clearCityCache } from '../utils/couriers/booking.js';
import { attemptReason, runCourierSync, refreshParcel } from '../utils/courierSync.js';
import { phaseOf, NEEDS_ATTENTION } from '../utils/couriers/statusWords.js';
import { orderSummary } from '../utils/orderSummary.js';
import { fakePostex, restoreFetch, setupOrder, dispatchBooked } from './helpers/courier.js';

/**
 * The courier's journey in plain phases (R9-1): every parcel carries one, a failed try or a review hold
 * is flagged for attention and rings the bell once, and "Refresh now" asks for one parcel immediately.
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

const booked = async record => {
  fakePostex({});
  const made = await setupOrder();
  await dispatchBooked(made.order, made.courier);
  const tracking = { 'CX-1001': record };
  fakePostex({ tracking });
  return { ...made, tracking };
};

test('every wording PostEx documents lands in the right phase', () => {
  const cases = [
    [{ status: 'Booked' }, 'booked'],
    [{ status: 'Unbooked' }, 'booked'],
    [{ status: 'PostEx WareHouse' }, 'at-warehouse'],
    [{ status: 'Picked By PostEx' }, 'at-warehouse'],
    [{ status: 'Out For Delivery' }, 'on-route'],
    [{ status: 'Out For Return' }, 'on-route'],
    [{ status: 'Attempted' }, 'attempt-failed'],
    [{ status: 'Delivery Under Review' }, 'under-review'],
    [{ status: 'Delivered' }, 'delivered'],
    [{ status: 'Returned' }, 'returned'],
    [{ status: 'Booking Cancelled by Merchant' }, 'cancelled']
  ];
  for (const [record, phase] of cases) assert.equal(phaseOf(record), phase, record.status);
});

test('with no status text the last journey code decides', () => {
  const byCode = { '0001': 'booked', '0003': 'at-warehouse', '0004': 'on-route' };
  for (const [code, phase] of Object.entries(byCode)) {
    assert.equal(phaseOf({ status: '', history: [{ code }] }), phase, code);
  }
  assert.equal(phaseOf({ status: '', history: [{ code: '0008' }] }), 'under-review');
  assert.equal(phaseOf({ status: '', history: [{ code: '0013' }] }), 'attempt-failed');
  assert.equal(phaseOf({ status: '', history: [{ code: '0005' }] }), 'delivered');
  assert.equal(phaseOf({ status: '', history: [{ code: '0007' }] }), 'returned');
});

test('a cancel wording beats the returned code PostEx files it under', () => {
  assert.equal(
    phaseOf({ status: '', history: [{ code: '0002', message: 'Booking Cancelled by Merchant' }] }),
    'cancelled'
  );
});

test('a word nobody has seen is unknown, shown as PostEx wrote it and never guessed', () => {
  assert.equal(phaseOf({ status: 'Held at customs', history: [] }), 'unknown');
  assert.equal(phaseOf({}), 'unknown');
  assert.equal(phaseOf(undefined), 'unknown');
});

test('only a failed try and a review hold need attention', () => {
  assert.deepEqual([...NEEDS_ATTENTION].sort(), ['attempt-failed', 'under-review']);
});

test('a delay is counted apart from a refusal', () => {
  assert.equal(attemptReason('Customer asked to deliver tomorrow'), 'rescheduled');
  assert.equal(attemptReason('Customer requested reschedule'), 'rescheduled');
  assert.equal(attemptReason('Customer refused to accept'), 'refused');
});

test('the check saves the phase; a routine step does not need attention and rings nothing', async () => {
  const { order } = await booked({
    transactionStatus: 'Out For Delivery',
    transactionStatusHistory: hist(['0004', 'Package on Route'])
  });
  await runCourierSync();

  const fresh = await Order.findById(order._id);
  assert.equal(fresh.courierBooking.phase, 'on-route');
  assert.ok(fresh.courierBooking.phaseAt);
  assert.equal(fresh.courierBooking.needsAttention, undefined);
  assert.equal(await Notification.countDocuments({ type: 'courier-issue' }), 0);
});

test('a failed try flags the parcel and rings the bell once, with the reason', async () => {
  const { order } = await booked({
    transactionStatus: 'Attempted',
    transactionStatusHistory: hist(['0013', 'Attempt Made: Customer not available'])
  });
  await runCourierSync();
  await runCourierSync();

  const fresh = await Order.findById(order._id);
  assert.equal(fresh.courierBooking.phase, 'attempt-failed');
  assert.equal(fresh.courierBooking.needsAttention, true);
  assert.equal(await Notification.countDocuments({ type: 'courier-issue' }), 1, 'not twice');
  const note = await Notification.findOne({ type: 'courier-issue' });
  assert.match(note.title, /Delivery try failed/);
  assert.equal(note.body, 'Customer not available');
  assert.equal(note.link, `/orders/${order._id}`);
});

test('the review hold rings once when it starts, and the flag clears when the parcel moves on', async () => {
  const { order, tracking } = await booked({
    transactionStatus: 'Delivery Under Review',
    transactionStatusHistory: hist(['0008', 'Delivery Under Review'])
  });
  await runCourierSync();
  await runCourierSync();
  assert.equal(await Notification.countDocuments({ type: 'courier-issue' }), 1);
  assert.equal((await Order.findById(order._id)).courierBooking.needsAttention, true);

  tracking['CX-1001'] = {
    transactionStatus: 'Out For Delivery',
    transactionStatusHistory: hist(['0008', 'Delivery Under Review'], ['0004', 'Package on Route'])
  };
  await runCourierSync();
  const fresh = await Order.findById(order._id);
  assert.equal(fresh.courierBooking.phase, 'on-route');
  assert.equal(
    fresh.courierBooking.needsAttention,
    undefined,
    'back to routine, nothing to look at'
  );
});

test('each journey step keeps the time we first noticed it', async () => {
  const { order, tracking } = await booked({
    transactionStatus: 'Out For Delivery',
    transactionStatusHistory: hist(['0003', 'At PostEx Warehouse'])
  });
  await runCourierSync();
  const first = (await Order.findById(order._id)).courierBooking.history[0].seenAt;
  assert.ok(first);

  await new Promise(r => setTimeout(r, 20));
  tracking['CX-1001'] = {
    transactionStatus: 'Out For Delivery',
    transactionStatusHistory: hist(['0003', 'At PostEx Warehouse'], ['0004', 'Package on Route'])
  };
  await runCourierSync();

  const history = (await Order.findById(order._id)).courierBooking.history;
  assert.equal(history[0].seenAt.getTime(), first.getTime(), 'the old step keeps its stamp');
  assert.ok(history[1].seenAt.getTime() > first.getTime(), 'the new step is stamped now');
});

test('the summary counts parcels that need attention', async () => {
  const { order } = await booked({
    transactionStatus: 'Attempted',
    transactionStatusHistory: hist(['0013', 'Attempt Made: Wrong address'])
  });
  await runCourierSync();
  const summary = await orderSummary(order.business);
  assert.equal(summary.needsAttention, 1);
});

test('Refresh now asks for the one parcel and applies the answer', async () => {
  const { order, tracking } = await booked({
    transactionStatus: 'Out For Delivery',
    transactionStatusHistory: hist(['0004', 'Package on Route'])
  });
  tracking['CX-1001'] = {
    transactionStatus: 'Attempted',
    transactionStatusHistory: hist(['0013', 'Attempt Made: Customer not available'])
  };

  const refreshed = await refreshParcel(await Order.findById(order._id));
  assert.equal(refreshed.courierBooking.phase, 'attempt-failed');
  assert.equal(refreshed.deliveryAttempts.length, 1);
});

test('a second Refresh within seconds reuses the first answer', async () => {
  const { order, tracking } = await booked({
    transactionStatus: 'Out For Delivery',
    transactionStatusHistory: hist(['0004', 'Package on Route'])
  });
  await refreshParcel(await Order.findById(order._id));
  tracking['CX-1001'] = {
    transactionStatus: 'Attempted',
    transactionStatusHistory: hist(['0013', 'Attempt Made: Customer not available'])
  };
  const again = await refreshParcel(await Order.findById(order._id));
  assert.equal(
    again.courierBooking.phase,
    'on-route',
    'the cooldown held and PostEx was not asked again'
  );
});

test('Refresh now is refused for an order that is not a dispatched courier parcel', async () => {
  fakePostex({});
  const { order } = await setupOrder();
  await assert.rejects(refreshParcel(await Order.findById(order._id)), /dispatched parcel/);
});
