import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, runHandler, oid } from './helpers/db.js';
import Order from '../models/Order.js';
import Party from '../models/Party.js';
import Account from '../models/Account.js';
import JournalEntry from '../models/JournalEntry.js';
import CourierReceipt from '../models/CourierReceipt.js';
import { clearCityCache } from '../utils/couriers/booking.js';
import { recordCourierWallets } from '../utils/courierWallet.js';
import { courierWalletParcels } from '../utils/courierWalletStatement.js';
import { importReceipt, presentPlan, previewReceipt } from '../utils/courierReceipts.js';
import { accountBalance } from '../utils/ledger.js';
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';
import {
  addCourierReceipt,
  previewCourierReceipt,
  reverseJournalEntry
} from '../controllers/financeController.js';
import { RETURNED, admin, deliveredParcel, recordingOn, restoreFetch } from './helpers/courier.js';

/**
 * Adding a PostEx receipt to the courier's wallet. The receipts here are already-read objects, so these tests do not
 * depend on the PDF reader (its own tests do). One delivered test parcel: COD 4,000.00, booked at 3,791.00 (PostEx's
 * fee and tax 209.00 already taken off), tracking CX-1001.
 */
before(connect);
after(disconnect);
afterEach(async () => {
  restoreFetch();
  clearCityCache();
  await clear();
});

const row = (tracking, status, { cod = 0, shipping = 18000, gst = 2900, deduction = 0 } = {}) => ({
  tracking,
  status,
  codPaisa: cod,
  shippingPaisa: shipping,
  gstPaisa: gst,
  deductionPaisa: deduction,
  netPaisa: status === 'delivered' ? cod - shipping - gst - deduction : -(shipping + gst)
});
const receiptOf = (rows, cprNumber = 'CPR-TEST1') => ({
  cprNumber,
  cprDate: '2026-11-04',
  merchant: null,
  totals: {
    netPaisa: rows.reduce((s, r) => s + r.netPaisa, 0),
    codPaisa: 0,
    shippingPaisa: 0,
    gstPaisa: 0,
    deductionPaisa: 0,
    delivered: rows.filter(r => r.status === 'delivered').length,
    returned: rows.filter(r => r.status === 'returned').length
  },
  rows
});
// A delivered parcel PostEx paid: 4,000.00 − 180.00 − 29.00 − 4 % (160.00) = 3,631.00.
const DELIVERED_ROW = () => row('CX-1001', 'delivered', { cod: 400000, deduction: 16000 });

const wallet = (biz, courier) => Account.findOne({ business: biz._id, courier: courier._id });
const bal = async (biz, code) => accountBalance(biz._id, (await accountByCode(biz._id, code))._id);
const walletBal = async (biz, courier) => {
  const w = await wallet(biz, courier);
  return w ? accountBalance(biz._id, w._id) : 0;
};
const add = (made, receipt) =>
  importReceipt({ business: made.biz._id, courier: made.courier, receipt, userId: admin.id });

test('an unpaid delivered parcel is paid with PostEx figure; the rest is booked as charges', async () => {
  const made = await deliveredParcel({ paid: false });
  const out = await add(made, receiptOf([DELIVERED_ROW()]));

  assert.equal(await walletBal(made.biz, made.courier), 363100);
  assert.equal(await bal(made.biz, CODES.COD_RECEIVABLE), 0);
  const fresh = await Order.findById(made.order._id);
  // 3,791.00 owed − 3,631.00 received = the 160.00 PostEx kept, on top of what delivery already booked.
  assert.equal(
    await bal(made.biz, CODES.DELIVERY_CHARGES),
    (fresh.deliveryChargePaisa ?? 0) + 16000
  );
  assert.equal(fresh.paymentStatus, 'paid');
  assert.equal(fresh.courierBooking.cprNumber, 'CPR-TEST1');
  assert.equal(fresh.courierBooking.walletPaisa, 363100);
  assert.equal(out.rows[0].case, 'paid');
});

test('a parcel whose fee was unknown at delivery gets its charge from the receipt', async () => {
  const made = await deliveredParcel({ paid: false });
  await Order.updateOne({ _id: made.order._id }, { $unset: { deliveryChargePaisa: 1 } });
  await add(made, receiptOf([DELIVERED_ROW()]));
  assert.equal((await Order.findById(made.order._id)).deliveryChargePaisa, 20900);
});

test('a parcel the old hourly job already paid is topped up by the difference only', async () => {
  const made = await deliveredParcel();
  await recordingOn(await Party.findById(made.courier._id));
  await recordCourierWallets();
  assert.equal(await walletBal(made.biz, made.courier), 379100);

  const out = await add(made, receiptOf([DELIVERED_ROW()]));
  assert.equal(out.rows[0].case, 'topup');
  assert.equal(await walletBal(made.biz, made.courier), 363100, 'ends at exactly PostEx figure');
  assert.equal(out.summary.alreadyInWalletPaisa, 379100);
});

test('a parcel paid by a manual courier invoice waits, with the reason', async () => {
  const made = await deliveredParcel({ paid: false });
  const sale = await JournalEntry.findOne({ business: made.biz._id });
  await Order.updateOne(
    { _id: made.order._id },
    { $set: { paymentStatus: 'paid', courierSettlement: sale._id } }
  );
  const before = await JournalEntry.countDocuments();
  const out = await add(made, receiptOf([DELIVERED_ROW()]));
  assert.equal(out.rows[0].outcome, 'pending');
  assert.match(out.rows[0].reason, /courier invoice/);
  assert.equal(await JournalEntry.countDocuments(), before, 'nothing posted for it');
});

test('a returned parcel charge moves onto the wallet at PostEx figure, replacing the estimate', async () => {
  const made = await deliveredParcel({ paid: false, record: RETURNED });
  // The status check had already set the charge from PostEx tracking (139.00) and owed it on the receivable.
  assert.equal((await Order.findById(made.order._id)).returnChargePaisa, 13900);
  assert.equal(await bal(made.biz, CODES.COD_RECEIVABLE), -13900);

  const out = await add(made, receiptOf([row('CX-1001', 'returned')]));
  assert.equal(out.rows[0].case, 'moveCharge');
  assert.equal(await bal(made.biz, CODES.COD_RECEIVABLE), 0);
  assert.equal(await walletBal(made.biz, made.courier), -20900);
  assert.equal(await bal(made.biz, CODES.RETURN_CHARGES), 20900);
  assert.equal((await Order.findById(made.order._id)).returnChargePaisa, 20900);
});

test('a return charge that matches is simply moved onto the wallet', async () => {
  const made = await deliveredParcel({ paid: false, record: RETURNED });
  await add(made, receiptOf([row('CX-1001', 'returned', { shipping: 12000, gst: 1900 })]));
  assert.equal(await bal(made.biz, CODES.COD_RECEIVABLE), 0);
  assert.equal(await walletBal(made.biz, made.courier), -13900);
  assert.equal(await bal(made.biz, CODES.RETURN_CHARGES), 13900);
});

test('a delivered parcel with no cash to collect is a charge on the wallet', async () => {
  const made = await deliveredParcel({ paid: false });
  await Order.updateOne({ _id: made.order._id }, { $unset: { deliveryChargePaisa: 1 } });
  const out = await add(made, receiptOf([row('CX-1001', 'delivered', { cod: 0 })]));
  assert.equal(out.rows[0].case, 'charge');
  assert.equal(await walletBal(made.biz, made.courier), -20900);
});

test('a parcel not in B Ledger is ignored, listed with its net, and never posted', async () => {
  const made = await deliveredParcel({ paid: false });
  const stranger = row('99999999999999', 'delivered', { cod: 100000, deduction: 4000 });
  const out = await add(made, receiptOf([DELIVERED_ROW(), stranger]));
  assert.equal(out.rows[1].outcome, 'ignored');
  assert.equal(out.summary.ignoredNetPaisa, stranger.netPaisa);
  assert.equal(out.summary.ignoredCount, 1);
  assert.equal(await walletBal(made.biz, made.courier), 363100, 'only the app parcel is in it');
});

test('a typed tracking id (no booking) still matches', async () => {
  const made = await deliveredParcel({ paid: false });
  await Order.updateOne(
    { _id: made.order._id },
    { $unset: { 'courierBooking.trackingNumber': 1 }, $set: { trackingId: 'TY-77' } }
  );
  const out = await add(made, receiptOf([{ ...DELIVERED_ROW(), tracking: 'TY-77' }]));
  assert.equal(out.rows[0].outcome, 'applied');
  assert.equal(await walletBal(made.biz, made.courier), 363100);
});

test('adding the same receipt twice posts nothing the second time', async () => {
  const made = await deliveredParcel({ paid: false });
  const receipt = receiptOf([DELIVERED_ROW()]);
  await add(made, receipt);
  const entries = await JournalEntry.countDocuments();
  const again = await add(made, receipt);
  assert.equal(await JournalEntry.countDocuments(), entries);
  assert.equal(again.summary.willAddPaisa, 0);
  assert.equal(again.summary.addedBeforeCount, 1);
  assert.equal(await walletBal(made.biz, made.courier), 363100);
});

test('a waiting parcel is added on the second run, once it is fixed', async () => {
  const made = await deliveredParcel({ paid: false });
  await Order.updateOne({ _id: made.order._id }, { $set: { status: 'dispatched' } });
  const receipt = receiptOf([DELIVERED_ROW()]);
  const first = await add(made, receipt);
  assert.equal(first.rows[0].outcome, 'pending');
  assert.equal(await walletBal(made.biz, made.courier), 0);

  await Order.updateOne({ _id: made.order._id }, { $set: { status: 'delivered' } });
  await add(made, receipt);
  assert.equal(await walletBal(made.biz, made.courier), 363100);
});

test('undoing the receipt entry puts every parcel and the wallet back', async () => {
  const made = await deliveredParcel({ paid: false });
  const before = await Order.findById(made.order._id);
  const out = await add(made, receiptOf([DELIVERED_ROW()]));

  await runHandler(reverseJournalEntry, { user: admin, resource: out.entry, body: {} });

  const after = await Order.findById(made.order._id);
  assert.equal(after.paymentStatus, before.paymentStatus);
  assert.equal(after.courierBooking.cprNumber, undefined);
  assert.equal(after.courierBooking.walletPaisa, undefined);
  assert.equal(await walletBal(made.biz, made.courier), 0);
  assert.equal(await bal(made.biz, CODES.COD_RECEIVABLE), 379100);
  assert.equal((await CourierReceipt.findOne()).rows[0].outcome, 'pending');

  await add(made, receiptOf([DELIVERED_ROW()]));
  assert.equal(await walletBal(made.biz, made.courier), 363100);
});

test('a receipt with no parcel of this business is refused; another business is never touched', async () => {
  const mine = await deliveredParcel({ paid: false });
  const other = await deliveredParcel({ paid: false }); // also CX-1001, in another business
  const stranger = row('55555555555555', 'delivered', { cod: 100000, deduction: 4000 });
  await assert.rejects(add(mine, receiptOf([stranger])), /None of these parcels/);

  await add(mine, receiptOf([DELIVERED_ROW()]));
  const untouched = await Order.findById(other.order._id);
  assert.equal(untouched.paymentStatus, 'unpaid');
  assert.equal(untouched.courierBooking.cprNumber, undefined);
  assert.equal(await walletBal(other.biz, other.courier), 0);
});

test('a preview posts and changes nothing', async () => {
  const made = await deliveredParcel({ paid: false });
  const entries = await JournalEntry.countDocuments();
  const accounts = await Account.countDocuments();
  const plan = await previewReceipt({
    business: made.biz._id,
    courier: made.courier,
    receipt: receiptOf([DELIVERED_ROW()])
  });
  assert.equal(plan.summary.willAddPaisa, 363100);
  assert.equal(await JournalEntry.countDocuments(), entries);
  assert.equal(await Account.countDocuments(), accounts);
  assert.equal(await CourierReceipt.countDocuments(), 0);
  assert.equal((await Order.findById(made.order._id)).paymentStatus, 'unpaid');
});

test('the wallet moves by the receipt net − ignored − pending, to the paisa', async () => {
  const made = await deliveredParcel({ paid: false });
  const out = await add(made, receiptOf([DELIVERED_ROW(), row('99999999999999', 'returned')]));
  const { receiptNetPaisa, ignoredNetPaisa, pendingNetPaisa } = out.summary;
  assert.equal(
    await walletBal(made.biz, made.courier),
    receiptNetPaisa - ignoredNetPaisa - pendingNetPaisa
  );
});

test('routes: a refused file is a 400; an empty body is refused; another business is a 404', async () => {
  const made = await deliveredParcel({ paid: false });
  const query = { business: String(made.biz._id), courier: String(made.courier._id) };
  await assert.rejects(
    runHandler(addCourierReceipt, { user: admin, query, body: Buffer.from('not a pdf') }),
    /could not be read as a PDF/
  );
  await assert.rejects(
    runHandler(previewCourierReceipt, { user: admin, query, body: Buffer.alloc(0) }),
    /as a PDF file/
  );
  await assert.rejects(
    runHandler(previewCourierReceipt, {
      user: admin,
      accessFilter: { business: { $in: [String(oid())] } },
      query,
      body: Buffer.from('x')
    }),
    /Business not found/
  );
});

test('the wallet statement shows each parcel with its receipt number and PostEx amount', async () => {
  const made = await deliveredParcel({ paid: false });
  const paid = made;
  await add(paid, receiptOf([DELIVERED_ROW()]));
  const w = await wallet(made.biz, made.courier);
  const { rows } = await courierWalletParcels(made.biz._id, w, { tab: 'paid', page: 1, limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'paid');
  assert.equal(rows[0].receipt, 'CPR-TEST1');
  assert.equal(rows[0].amountPaisa, 363100);

  const returned = await deliveredParcel({ paid: false, record: RETURNED });
  await add(returned, receiptOf([row('CX-1001', 'returned')], 'CPR-TEST2'));
  const w2 = await wallet(returned.biz, returned.courier);
  const out = await courierWalletParcels(returned.biz._id, w2, {
    tab: 'charges',
    page: 1,
    limit: 10
  });
  assert.equal(out.rows[0].kind, 'charge');
  assert.equal(out.rows[0].receipt, 'CPR-TEST2');
  assert.equal(out.rows[0].amountPaisa, -20900);
});

test('what the screen gets is in rupees, with paisa kept, and carries no journal internals', async () => {
  const made = await deliveredParcel({ paid: false });
  const receipt = receiptOf([DELIVERED_ROW(), row('99999999999999', 'returned')]);
  const out = presentPlan(await add(made, receipt), receipt);
  assert.equal(out.summary.willAdd, 3631);
  assert.equal(out.summary.ignoredNet, -209);
  assert.equal(out.rows[0].difference, -160, 'PostEx paid 160.00 less than the app expected');
  assert.equal(out.rows[1].outcome, 'ignored');
  const text = JSON.stringify(out);
  assert.ok(!text.includes('previous') && !text.includes('lines') && !text.includes('Paisa'));
});

test('a failure after the money is posted undoes it, so adding the receipt again never counts it twice', async () => {
  const made = await deliveredParcel({ paid: false });
  const receipt = receiptOf([DELIVERED_ROW()]);
  const realUpdate = CourierReceipt.updateOne.bind(CourierReceipt);
  // Saving the receipt's rows (the last step, after the entry is posted) fails once.
  CourierReceipt.updateOne = (filter, update, ...rest) =>
    update?.$set?.rows
      ? Promise.reject(new Error('disk full'))
      : realUpdate(filter, update, ...rest);
  try {
    await assert.rejects(add(made, receipt), /disk full/);
  } finally {
    CourierReceipt.updateOne = realUpdate;
  }

  assert.equal(await walletBal(made.biz, made.courier), 0, 'the posted money was undone');
  assert.equal(await bal(made.biz, CODES.COD_RECEIVABLE), 379100);
  const order = await Order.findById(made.order._id);
  assert.equal(order.paymentStatus, 'unpaid');
  assert.equal(order.courierBooking.cprNumber, undefined);
  assert.equal(order.courierBooking.walletPaisa, undefined);

  await add(made, receipt);
  assert.equal(await walletBal(made.biz, made.courier), 363100, 'once, not twice');
});
