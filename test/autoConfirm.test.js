import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, runHandler, userId } from './helpers/db.js';
import Order from '../models/Order.js';
import Party from '../models/Party.js';
import JournalEntry from '../models/JournalEntry.js';
import { clearCityCache } from '../utils/couriers/booking.js';
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { runCourierSync, refreshParcel } from '../utils/courierSync.js';
import { confirmOneFromCourier } from '../controllers/orderController.js';
import { saveConnection } from '../controllers/courierConnectionController.js';
import { courierConnectionSchema } from '../schemas/parties.js';
import { admin, fakePostex, restoreFetch, setupOrder, dispatchBooked } from './helpers/courier.js';

/**
 * Marking a parcel delivered / returned by itself (R9-6): only when the courier's switch is on, only after
 * TWO checks in a row say the same, through the very function a person's tap uses, once per parcel even
 * if a tap races it, and never for a parcel we cancelled at the courier ourselves.
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

const delivered = {
  transactionStatus: 'Delivered',
  transactionFee: 180,
  transactionTax: 29,
  transactionStatusHistory: hist(['0005', 'Delivered'])
};

const booked = async (record, opts) => {
  fakePostex({});
  const made = await setupOrder(opts);
  await dispatchBooked(made.order, made.courier);
  const tracking = { 'CX-1001': record };
  fakePostex({ tracking });
  return { ...made, tracking };
};

const sync = () => runCourierSync({ confirm: confirmOneFromCourier });

test('a new connection starts with automatic marking ON; an older one is not changed silently', async () => {
  fakePostex({});
  const { courier } = await setupOrder();
  assert.equal((await Party.findById(courier._id)).integration.autoConfirm, true);
  assert.equal(
    String((await Party.findById(courier._id)).integration.autoConfirmBy),
    String(userId)
  );

  // An older connection: made before the switch existed, so it has no value at all.
  await Party.updateOne(
    { _id: courier._id },
    { $unset: { 'integration.autoConfirm': 1, 'integration.autoConfirmBy': 1 } }
  );
  await runHandler(saveConnection, {
    user: admin,
    resource: await Party.findById(courier._id),
    body: courierConnectionSchema.parse({ pickupAddressLabel: 'Warehouse' })
  });
  assert.equal(
    (await Party.findById(courier._id)).integration.autoConfirm,
    undefined,
    'saving something else leaves it'
  );

  await runHandler(saveConnection, {
    user: admin,
    resource: await Party.findById(courier._id),
    body: courierConnectionSchema.parse({ autoConfirm: true })
  });
  assert.equal((await Party.findById(courier._id)).integration.autoConfirm, true);
});

test('the first check only marks the parcel ready; the second one confirms it, like a tap would', async () => {
  const { order } = await booked(delivered);

  const first = await sync();
  assert.equal(first.autoConfirmed, 0);
  let fresh = await Order.findById(order._id);
  assert.equal(
    fresh.status,
    'dispatched',
    'one sighting is not enough — delivered can not be taken back'
  );
  assert.equal(fresh.courierBooking.confirmable, 'delivered');
  assert.equal(fresh.courierBooking.seenCount, 1);

  const second = await sync();
  assert.equal(second.autoConfirmed, 1);
  fresh = await Order.findById(order._id);
  assert.equal(fresh.status, 'delivered');
  assert.ok(fresh.saleEntry, 'the sale was posted by the normal path');
  assert.equal(fresh.courierBooking.confirmable, undefined);
  assert.equal(fresh.deliveryChargePaisa, 20900, 'PostEx’s fee and tax were filled in');
  assert.match(fresh.statusHistory.at(-1).note, /Marked automatically from the courier/);
});

test('the books name the person who turned the switch on, and nobody is invented', async () => {
  const { order } = await booked(delivered);
  await sync();
  await sync();
  const entry = await JournalEntry.findById((await Order.findById(order._id)).saleEntry);
  assert.equal(String(entry.createdBy), String(userId));
});

test('with the switch off nothing is ever marked automatically', async () => {
  const { order, courier } = await booked(delivered);
  await Party.updateOne({ _id: courier._id }, { $set: { 'integration.autoConfirm': false } });
  await sync();
  await sync();
  await sync();
  assert.equal((await Order.findById(order._id)).status, 'dispatched');
});

test('without the confirm hook the sync still only marks (as before this feature)', async () => {
  const { order } = await booked(delivered);
  await runCourierSync();
  await runCourierSync();
  assert.equal((await Order.findById(order._id)).status, 'dispatched');
});

test('delivered, then attempted, then delivered again needs two fresh checks, not one', async () => {
  const { order, tracking } = await booked(delivered);
  await sync(); // delivered #1
  tracking['CX-1001'] = {
    transactionStatus: 'Attempted',
    transactionStatusHistory: hist(['0013', 'Attempt Made: Customer not available'])
  };
  await sync(); // the courier changed its mind
  assert.equal((await Order.findById(order._id)).courierBooking.seenCount, undefined);

  tracking['CX-1001'] = delivered;
  await sync(); // delivered #1 again
  assert.equal((await Order.findById(order._id)).status, 'dispatched');
  await sync(); // delivered #2
  assert.equal((await Order.findById(order._id)).status, 'delivered');
});

test('a returned parcel is marked returned the same way', async () => {
  const { order } = await booked({
    transactionStatus: 'Returned',
    reversalFee: 120,
    reversalTax: 19,
    transactionStatusHistory: hist(['0006', 'Returned'])
  });
  await sync();
  await sync();
  const fresh = await Order.findById(order._id);
  assert.equal(fresh.status, 'returned');
  assert.equal(fresh.returnChargePaisa, 13900);
});

test('a parcel WE cancelled at the courier is never auto-returned', async () => {
  const { order } = await booked({
    transactionStatus: '',
    transactionStatusHistory: hist(['0002', 'Booking Cancelled by Merchant'])
  });
  await sync();
  await sync();
  const fresh = await Order.findById(order._id);
  assert.equal(fresh.status, 'dispatched');
  assert.equal(fresh.courierBooking.confirmable, undefined);
  assert.equal(fresh.courierBooking.phase, 'cancelled');
});

test('"Refresh now" does not count as a check: two quick taps are not two checks apart', async () => {
  const { order } = await booked(delivered);
  await refreshParcel(await Order.findById(order._id));
  const afterRefresh = await Order.findById(order._id);
  assert.equal(afterRefresh.courierBooking.confirmable, 'delivered');
  assert.equal(afterRefresh.courierBooking.seenCount, undefined, 'the tap left the count alone');

  await sync(); // the first real check
  assert.equal((await Order.findById(order._id)).status, 'dispatched');
  await sync();
  assert.equal((await Order.findById(order._id)).status, 'delivered');
});

test('a tap and an automatic confirm racing for one parcel post its sale once', async () => {
  const { order } = await booked(delivered);
  await sync(); // ready
  const results = await Promise.all([
    confirmOneFromCourier({ id: order._id, user: admin }),
    confirmOneFromCourier({ id: order._id, user: { id: userId }, auto: true })
  ]);
  assert.equal(results.filter(r => r.ok).length, 1, 'exactly one of them did it');
  const fresh = await Order.findById(order._id);
  assert.equal(fresh.status, 'delivered');
  assert.ok(fresh.saleEntry);
  // Only one entry on this order credits Sales: the sale was posted once, not twice.
  const salesAccount = await accountByCode(fresh.business, CODES.SALES);
  const entries = await JournalEntry.find({
    business: fresh.business,
    'source.kind': 'order',
    'source.ref': String(fresh._id)
  });
  const credited = entries.filter(e =>
    e.lines.some(l => String(l.account) === String(salesAccount._id) && l.creditPaisa > 0)
  );
  assert.equal(credited.length, 1);
});

test('when the confirm can not be done, the parcel stays ready for a person and the claim is released', async () => {
  const { order } = await booked(delivered);
  await sync();
  const refusing = async () => ({ ok: false, reason: 'not now' });
  await runCourierSync({ confirm: refusing });
  const fresh = await Order.findById(order._id);
  assert.equal(fresh.status, 'dispatched');
  assert.equal(fresh.courierBooking.confirmable, 'delivered', 'a person can still tap it');
  assert.equal(fresh.courierBooking.confirmClaimedAt, undefined);
});

test('a person’s tap on a parcel nobody reported is still refused', async () => {
  const { order } = await booked({
    transactionStatus: 'Out For Delivery',
    transactionStatusHistory: hist(['0004', 'Package on Route'])
  });
  await sync();
  const out = await confirmOneFromCourier({ id: order._id, user: admin });
  assert.equal(out.ok, false);
  assert.match(out.reason, /has not reported/);
});
