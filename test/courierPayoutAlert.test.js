import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect } from './helpers/db.js';
import Order from '../models/Order.js';
import Account from '../models/Account.js';
import JournalEntry from '../models/JournalEntry.js';
import Notification from '../models/Notification.js';
import { clearCityCache } from '../utils/couriers/booking.js';
import { checkCourierPayouts } from '../utils/courierPayoutAlert.js';
import { courierWalletSummary } from '../utils/courierWalletStatement.js';
import { importReceipt } from '../utils/courierReceipts.js';
import { accountBalance } from '../utils/ledger.js';
import { admin, deliveredParcel, restoreFetch } from './helpers/courier.js';

/**
 * "PostEx has paid — add its receipt": the bell rings once per paid parcel and points at the wallet, and it NEVER
 * moves money — only the receipt does.
 */
before(connect);
after(disconnect);
afterEach(async () => {
  restoreFetch();
  clearCityCache();
  await clear();
});

const walletOf = made => Account.findOne({ business: made.biz._id, courier: made.courier._id });

test('a parcel PostEx has paid rings the bell once, pointing at the wallet, and posts nothing', async () => {
  const made = await deliveredParcel(); // PostEx answers "paid" for CX-1001
  const entries = await JournalEntry.countDocuments();

  const tally = await checkCourierPayouts();
  assert.equal(tally.paid, 1);

  const note = await Notification.findOne({ type: 'courier-paid' });
  assert.match(note.title, /has paid 1 parcel — add its receipt/);
  assert.match(note.body, /Download the receipt \(CPR\)/);
  const wallet = await walletOf(made);
  assert.equal(note.link, `/finance/courier-wallet?account=${wallet._id}`);

  // Nothing moved: no entry, wallet empty, the parcel still unpaid — only marked as paid by PostEx.
  assert.equal(await JournalEntry.countDocuments(), entries);
  assert.equal(await accountBalance(made.biz._id, wallet._id), 0);
  const order = await Order.findById(made.order._id);
  assert.equal(order.paymentStatus, 'unpaid');
  assert.ok(order.courierBooking.postexPaidOn);

  // A second pass does not ring again.
  await checkCourierPayouts({ now: new Date(Date.now() + 4 * 60 * 60 * 1000) });
  assert.equal(await Notification.countDocuments({ type: 'courier-paid' }), 1);
});

test('a parcel PostEx has not paid rings nothing', async () => {
  await deliveredParcel({ paid: false });
  assert.equal((await checkCourierPayouts()).paid, 0);
  assert.equal(await Notification.countDocuments({ type: 'courier-paid' }), 0);
});

test('the wallet counts parcels waiting for their receipt, until the receipt is added', async () => {
  const made = await deliveredParcel();
  await checkCourierPayouts();
  const wallet = await walletOf(made);
  assert.equal((await courierWalletSummary(made.biz._id, wallet)).awaitingReceipt, 1);

  const row = {
    tracking: 'CX-1001',
    status: 'delivered',
    codPaisa: 400000,
    shippingPaisa: 18000,
    gstPaisa: 2900,
    deductionPaisa: 16000,
    netPaisa: 363100
  };
  await importReceipt({
    business: made.biz._id,
    courier: made.courier,
    receipt: {
      cprNumber: 'CPR-T1',
      cprDate: '2026-11-04',
      merchant: null,
      totals: { netPaisa: 363100, delivered: 1, returned: 0 },
      rows: [row]
    },
    userId: admin.id
  });
  assert.equal((await courierWalletSummary(made.biz._id, wallet)).awaitingReceipt, 0);
});
