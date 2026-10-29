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
import * as real from './fixtures/postexTracks.js';
import { normalizeTracking } from '../utils/couriers/postex.js';

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
  // A real fixture carries its own (anonymised) tracking number; the parcel booked here is CX-1001.
  const tracking = { 'CX-1001': { ...record, trackingNumber: 'CX-1001' } };
  fakePostex({ tracking });
  return { ...made, tracking };
};

test('every wording PostEx documents lands in the right phase', () => {
  const cases = [
    [{ status: 'Booked' }, 'booked'],
    [{ status: 'Unbooked' }, 'unbooked'],
    [{ status: 'PostEx WareHouse' }, 'at-warehouse'],
    [{ status: 'Picked By PostEx' }, 'picked-up'],
    [{ status: 'En-Route to Islamabad warehouse' }, 'in-transit'],
    [{ status: 'Expired' }, 'expired'],
    [{ status: 'Out For Delivery' }, 'on-route'],
    [{ status: 'Out For Return' }, 'returning'],
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

test('only a failed try, a review hold and an expired parcel need attention', () => {
  assert.deepEqual([...NEEDS_ATTENTION].sort(), ['attempt-failed', 'expired', 'under-review']);
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

/** What the app reads from a real PostEx answer: the word, and the journey with its times. */
const fresh = record => ({
  status: record.transactionStatus ?? '',
  history: record.transactionStatusHistory.map(h => ({
    code: h.transactionStatusMessageCode,
    message: h.transactionStatusMessage,
    at: h.updatedAt ?? h.modifiedDatetime
  }))
});

test('real PostEx parcels land in the stage a person would give them', () => {
  const expected = [
    ['REFUSED_AND_RETURNING', 'returning'],
    ['NEWEST_FIRST', 'returning'],
    ['DELIVERED', 'delivered'],
    ['WAITING_FOR_DELIVERY', 'at-warehouse'],
    ['PICKED', 'picked-up'],
    ['UNDER_REVIEW', 'under-review'],
    ['CANCELLED', 'cancelled'],
    ['UNBOOKED', 'unbooked'],
    ['ATTEMPT_CNA', 'attempt-failed']
  ];
  for (const [name, phase] of expected) assert.equal(phaseOf(fresh(real[name])), phase, name);
});

test('a refused parcel on its way back is returning even though its word says it is at a warehouse', () => {
  assert.equal(real.REFUSED_AND_RETURNING.transactionStatus, 'En-Route to Islamabad warehouse');
  assert.equal(phaseOf(fresh(real.REFUSED_AND_RETURNING)), 'returning');
});

test('the journey is read in time order whichever way the courier lists it', () => {
  // Newest first, with no status word at all: the newest step is still the one that decides.
  assert.equal(phaseOf(fresh(real.NEWEST_FIRST)), 'returning');
  // A second delivery try after a return step puts it back out for delivery.
  const again = fresh(real.REFUSED_AND_RETURNING);
  again.history.push({
    code: '0004',
    message: 'Enroute for Delivery',
    at: '2026-10-30T09:00:00.000+0500'
  });
  again.status = 'Out For Delivery';
  assert.equal(phaseOf(again), 'on-route');
});

test('TCS keeps its own word rules until its codes are known', () => {
  assert.equal(phaseOf({ status: 'Arrived at TCS Facility' }, 'tcs'), 'at-warehouse');
  assert.equal(phaseOf({ status: 'Delivered' }, 'tcs'), 'delivered');
});

test('PostEx’s own time is kept on every step, whichever field it arrives in', () => {
  const real1 = normalizeTracking(real.DELIVERED);
  assert.equal(real1.history.length, 8);
  assert.equal(real1.history.at(-1).at, '2026-10-29T13:20:00.000+0500');
  assert.equal(real1.fee, 231.25);

  const other = normalizeTracking(real.NEWEST_FIRST);
  assert.equal(
    other.history[0].at,
    '2026-10-29T14:57:55.000+0500',
    'modifiedDatetime is used when updatedAt is absent'
  );
  assert.equal(phaseOf(other), 'returning');
});

test('PostEx’s reason codes are read, so "not available" and "hold" are not filed as other', () => {
  assert.equal(attemptReason('RFD(REFUSED TO RECEIVE)'), 'refused');
  assert.equal(attemptReason('CNA(CNA)'), 'not-available');
  assert.equal(attemptReason('HCR(HOLD ON CONSIGNEE REQUEST)'), 'rescheduled');
  // Plain words still work, and a capitalised word that is not a code does not trip the reader.
  assert.equal(attemptReason('Customer not available'), 'not-available');
  assert.equal(attemptReason('NOT AT HOME'), 'not-available');
  assert.equal(attemptReason('XYZ(something odd)'), 'other');
});

test('a real CNA attempt is logged as not-available, with PostEx’s own words kept', async () => {
  const { order } = await booked(real.ATTEMPT_CNA);
  await runCourierSync();
  const fresh = await Order.findById(order._id);
  assert.equal(fresh.deliveryAttempts.length, 1);
  assert.equal(fresh.deliveryAttempts[0].reason, 'not-available');
  assert.equal(fresh.deliveryAttempts[0].note, 'PostEx: CNA(CNA)');
});
