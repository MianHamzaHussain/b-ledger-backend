import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connect, clear, disconnect, runHandler, userId } from './helpers/db.js';
import Order from '../models/Order.js';
import Party from '../models/Party.js';
import Account from '../models/Account.js';
import { clearCityCache } from '../utils/couriers/booking.js';
import { recordCourierWallets } from '../utils/courierWallet.js';
import { courierWalletFor } from '../utils/moneyAccounts.js';
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { getCourierWallet, getCourierWalletParcels } from '../controllers/financeController.js';
import { RETURNED, restoreFetch, deliveredParcel, recordingOn } from './helpers/courier.js';

/**
 * The courier's wallet parcel by parcel: which tracking numbers were paid (+) and charged (−), what is still to come,
 * and where the wallet stands. A light summary and a PAGE of parcels per tab, so a long history never loads at once.
 * Everything shown is already in the books; nothing is posted by reading it.
 */
before(connect);
after(disconnect);
afterEach(async () => {
  restoreFetch();
  clearCityCache();
  await clear();
});

const ask = (handler, biz, wallet, query = {}) =>
  runHandler(handler, {
    query: { business: String(biz._id), account: String(wallet._id), ...query },
    accessFilter: {}
  });
const summary = async (biz, wallet) => (await ask(getCourierWallet, biz, wallet)).body.data;
const parcels = async (biz, wallet, query) =>
  (await ask(getCourierWalletParcels, biz, wallet, query)).body;

const walletFor = async (biz, courier) =>
  courierWalletFor(biz._id, await Party.findById(courier._id), userId);

/** The same parcel again under another number — a quick way to have several parcels in one business. */
const copyOf = async (order, tracking, over = {}) => {
  // The parcel as it is NOW — delivered and paid — not as it was when the test began.
  const doc = (await Order.findById(order._id)).toObject();
  delete doc.clientRef;
  const unique = tracking.replace(/\D/g, '');
  await Order.collection.insertOne({
    ...doc,
    _id: new mongoose.Types.ObjectId(),
    orderNumber: `9${unique}`,
    trackingId: tracking,
    courierBooking: { ...doc.courierBooking, trackingNumber: tracking, ...over.courierBooking },
    ...over.fields
  });
};

test('a paid parcel is listed with its tracking number and order, as what it paid in', async () => {
  const { order, courier, biz } = await deliveredParcel();
  await recordingOn(await Party.findById(courier._id));
  await recordCourierWallets();
  const wallet = await walletFor(biz, courier);

  const list = await parcels(biz, wallet);
  assert.equal(list.total, 1);
  const [paid] = list.data;
  assert.equal(paid.kind, 'paid');
  assert.equal(paid.tracking, 'CX-1001');
  assert.equal(String(paid.order), String(order._id));
  assert.equal(paid.orderNumber, order.orderNumber);
  assert.equal(paid.amount, 3791, 'COD 4,000 minus the 209 charge');

  const out = await summary(biz, wallet);
  assert.equal(out.inWallet, 3791);
  assert.equal(out.owed, 0);
  assert.equal(out.willGet, 3791);
  assert.deepEqual(out.counts, { paid: 1, charges: 0, upcoming: 0, all: 1 });
});

test('a returned parcel is listed as a charge taken off — a minus', async () => {
  const { courier, biz } = await deliveredParcel({ paid: false, record: RETURNED });
  await recordingOn(await Party.findById(courier._id));
  await recordCourierWallets();
  const wallet = await walletFor(biz, courier);

  const [charge] = (await parcels(biz, wallet)).data;
  assert.ok(
    (await Order.findById(charge.order)).courierBooking.walletChargedAt,
    'when it was taken is kept'
  );
  assert.equal(charge.kind, 'charge');
  assert.equal(charge.reason, 'returned');
  assert.equal(charge.amount, -139);

  const out = await summary(biz, wallet);
  assert.equal(out.inWallet, -139);
  assert.equal(out.willGet, -139);
});

test('a delivered parcel the courier has not paid yet is what is still to come', async () => {
  const { courier, biz } = await deliveredParcel({ paid: false });
  const wallet = await walletFor(biz, courier);

  const [owed] = (await parcels(biz, wallet)).data;
  assert.equal(owed.kind, 'owed');
  assert.equal(owed.amount, 3791);

  const out = await summary(biz, wallet);
  assert.equal(out.inWallet, 0);
  assert.equal(out.owed, 3791);
  assert.equal(out.willGet, 3791, 'nothing in the wallet yet, but this is coming');
  assert.equal(out.counts.upcoming, 1);
});

test('a charge not yet on the wallet shows as coming off, and lowers what you will get', async () => {
  const { courier, biz } = await deliveredParcel({ paid: false, record: RETURNED });
  const wallet = await walletFor(biz, courier);

  const [pending] = (await parcels(biz, wallet)).data;
  assert.equal(pending.kind, 'charge-pending');
  assert.equal(pending.amount, -139);

  const out = await summary(biz, wallet);
  assert.equal(out.charges, 139);
  assert.equal(out.willGet, -139);
  assert.equal(out.counts.upcoming, 1);
});

test('the figure comes back from the books for a parcel recorded before its amount was kept', async () => {
  const { order, courier, biz } = await deliveredParcel();
  await recordingOn(await Party.findById(courier._id));
  await recordCourierWallets();
  await Order.updateOne(
    { _id: order._id },
    { $unset: { 'courierBooking.walletPaisa': 1 } },
    { timestamps: false }
  );

  const [row] = (await parcels(biz, await walletFor(biz, courier))).data;
  assert.equal(row.amount, 3791);
});

test('parcels come a page at a time, newest first, with the list envelope', async () => {
  const { order, courier, biz } = await deliveredParcel();
  await recordingOn(await Party.findById(courier._id));
  await recordCourierWallets();
  const wallet = await walletFor(biz, courier);
  const paidAt = (await Order.findById(order._id)).courierBooking.codSettledAt;
  await copyOf(order, 'CX-2001', {
    courierBooking: { codSettledAt: new Date(paidAt.getTime() + 3_600_000) }
  });
  await copyOf(order, 'CX-2002', {
    courierBooking: { codSettledAt: new Date(paidAt.getTime() + 7_200_000) }
  });

  const first = await parcels(biz, wallet, { limit: 2 });
  assert.equal(first.success, true);
  assert.equal(first.total, 3);
  assert.equal(first.count, 2);
  assert.deepEqual(
    first.data.map(r => r.tracking),
    ['CX-2002', 'CX-2001'],
    'the latest first'
  );
  assert.deepEqual(first.pagination, { next: { page: 2, limit: 2 } });

  const second = await parcels(biz, wallet, { limit: 2, page: 2 });
  assert.deepEqual(
    second.data.map(r => r.tracking),
    ['CX-1001']
  );
  assert.deepEqual(second.pagination, {}, 'nothing after the last page');
});

test('each tab holds only its own parcels, and the counts say how many', async () => {
  const { order, courier, biz } = await deliveredParcel();
  await recordingOn(await Party.findById(courier._id));
  await recordCourierWallets();
  const wallet = await walletFor(biz, courier);
  // The same parcel, delivered but not yet paid by the courier.
  await copyOf(order, 'CX-3001', {
    fields: { paymentStatus: 'unpaid', courierSettlement: undefined },
    courierBooking: { walletPaisa: undefined, codSettledAt: undefined }
  });

  assert.deepEqual(
    (await parcels(biz, wallet, { tab: 'paid' })).data.map(r => r.tracking),
    ['CX-1001']
  );
  const upcoming = await parcels(biz, wallet, { tab: 'upcoming' });
  assert.deepEqual(
    upcoming.data.map(r => [r.tracking, r.kind]),
    [['CX-3001', 'owed']]
  );
  assert.equal((await parcels(biz, wallet, { tab: 'charges' })).total, 0);
  assert.equal((await parcels(biz, wallet, { tab: 'all' })).total, 2);
  assert.deepEqual((await summary(biz, wallet)).counts, {
    paid: 1,
    charges: 0,
    upcoming: 1,
    all: 2
  });
});

test('a tracking number, an order number or a customer finds its parcel', async () => {
  const { order, courier, biz } = await deliveredParcel();
  await recordingOn(await Party.findById(courier._id));
  await recordCourierWallets();
  const wallet = await walletFor(biz, courier);
  await copyOf(order, 'CX-4001');

  assert.deepEqual(
    (await parcels(biz, wallet, { search: 'cx-4001' })).data.map(r => r.tracking),
    ['CX-4001']
  );
  assert.equal((await parcels(biz, wallet, { search: order.orderNumber })).total >= 1, true);
  assert.equal((await parcels(biz, wallet, { search: 'Sana' })).total, 2, 'by customer');
  assert.equal((await parcels(biz, wallet, { search: 'no such thing' })).total, 0);
  assert.equal(
    (await parcels(biz, wallet, { search: '.*' })).total,
    0,
    'what is typed is a word, not a pattern'
  );
});

test('only a courier wallet of this business can be read', async () => {
  const { biz, courier } = await deliveredParcel();
  const cash = await accountByCode(biz._id, CODES.CASH);
  await assert.rejects(ask(getCourierWallet, biz, cash), /not a courier wallet/);
  await assert.rejects(ask(getCourierWalletParcels, biz, cash), /not a courier wallet/);

  const wallet = await walletFor(biz, courier);
  assert.ok(await Account.exists({ _id: wallet._id, heldByCourier: true }));
  await assert.rejects(
    runHandler(getCourierWallet, {
      query: { business: String(biz._id), account: 'not-an-id' },
      accessFilter: {}
    }),
    /not a courier wallet/
  );
});

test('another business’s wallet reads as not found, never as forbidden', async () => {
  const { biz, courier } = await deliveredParcel();
  const wallet = await walletFor(biz, courier);
  const elsewhere = { business: { $in: [String(new mongoose.Types.ObjectId())] } };
  for (const handler of [getCourierWallet, getCourierWalletParcels]) {
    await assert.rejects(
      runHandler(handler, {
        query: { business: String(biz._id), account: String(wallet._id) },
        accessFilter: elsewhere
      }),
      /Business not found/
    );
  }
});
