import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, runHandler, userId } from './helpers/db.js';
import Order from '../models/Order.js';
import Party from '../models/Party.js';
import Account from '../models/Account.js';
import Business from '../models/Business.js';
import JournalEntry from '../models/JournalEntry.js';
import Notification from '../models/Notification.js';
import { clearCityCache } from '../utils/couriers/booking.js';
import { runCourierSync } from '../utils/courierSync.js';
import { recordCourierWallets } from '../utils/courierWallet.js';
import { resolveMoney } from '../utils/moneyAccounts.js';
import { accountBalance } from '../utils/ledger.js';
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { confirmOneFromCourier } from '../controllers/orderController.js';
import { recordTransfer } from '../controllers/moneyAccountController.js';
import { reverseJournalEntry } from '../controllers/financeController.js';
import { saveConnection } from '../controllers/courierConnectionController.js';
import { courierConnectionSchema } from '../schemas/parties.js';
import { admin, fakePostex, restoreFetch, setupOrder, dispatchBooked } from './helpers/courier.js';

/**
 * The courier's wallet (R9-6): money the courier holds for the shop. Off unless an admin switched it on;
 * when on, a parcel the courier says it has paid goes into the wallet (COD − fee − taxes, once), a returned
 * parcel's charge takes it down (it can go minus), and it can only be moved out — never spent.
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

const DELIVERED = {
  transactionStatus: 'Delivered',
  transactionFee: 180,
  transactionTax: 29,
  transactionStatusHistory: hist(['0005', 'Delivered'])
};

/** A parcel that is booked, then marked delivered (fee 209 known) by the automatic confirm. */
const deliveredParcel = async ({ paid = true, record = DELIVERED, codTax } = {}) => {
  fakePostex({});
  const made = await setupOrder();
  // COD tax as the business has it when the parcel is delivered (default none, to keep the sums plain).
  await Business.updateOne(
    { _id: made.biz._id },
    { $set: { codTax: codTax ?? { whtPercent: 0, salesTaxPercent: 0 } } }
  );
  await dispatchBooked(made.order, made.courier);
  fakePostex({ tracking: { 'CX-1001': record }, paid: paid ? ['CX-1001'] : [] });
  const sync = () => runCourierSync({ confirm: confirmOneFromCourier });
  await sync();
  await sync();
  return made;
};

const recordingOn = courier =>
  runHandler(saveConnection, {
    user: admin,
    resource: courier,
    body: courierConnectionSchema.parse({ recordPayments: true })
  });

const walletOf = (biz, courier) => Account.findOne({ business: biz._id, courier: courier._id });
const balanceOf = async (biz, account) => accountBalance(biz._id, account._id);

test('off by default: a paid parcel is left alone and no wallet is made', async () => {
  const { order, courier, biz } = await deliveredParcel();
  assert.equal((await Order.findById(order._id)).status, 'delivered');

  assert.deepEqual(await recordCourierWallets(), {
    couriers: 0,
    checked: 0,
    paid: 0,
    paidPaisa: 0,
    charges: 0,
    errors: 0
  });
  assert.equal(await walletOf(biz, courier), null);
  assert.equal((await Order.findById(order._id)).paymentStatus, 'unpaid');
});

test('switched on: the paid parcel goes into the wallet for COD − fee − taxes, once', async () => {
  const { order, courier, biz } = await deliveredParcel({
    codTax: { whtPercent: 1, salesTaxPercent: 0 }
  });
  await recordingOn(await Party.findById(courier._id));

  const tally = await recordCourierWallets();
  assert.equal(tally.paid, 1);

  // COD 4,000 − fee and tax 209 − 1% withholding on the COD (40) = 3,751.
  const wallet = await walletOf(biz, courier);
  assert.ok(wallet.heldByCourier);
  assert.equal(wallet.moneyKind, 'wallet');
  assert.equal(await balanceOf(biz, wallet), 375100);

  const fresh = await Order.findById(order._id);
  assert.equal(fresh.paymentStatus, 'paid');
  assert.ok(fresh.courierSettlement);
  assert.ok(fresh.courierBooking.codSettledAt);

  const note = await Notification.findOne({ type: 'courier-paid' });
  assert.match(note.title, /paid 1 parcel — Rs 3,751/);

  // A second run adds nothing: the parcel is paid.
  assert.equal((await recordCourierWallets()).paid, 0);
  assert.equal(await balanceOf(biz, wallet), 375100);
  assert.equal(await Notification.countDocuments({ type: 'courier-paid' }), 1);
});

test('the receivable and the wallet move together: what the courier owed becomes what it holds', async () => {
  const { courier, biz } = await deliveredParcel();
  await recordingOn(await Party.findById(courier._id));
  const receivable = await accountByCode(biz._id, CODES.COD_RECEIVABLE);
  const owedBefore = await accountBalance(biz._id, receivable._id);
  assert.equal(owedBefore, 379100, 'delivered: the courier owed COD − fee − taxes');

  await recordCourierWallets();
  assert.equal(await accountBalance(biz._id, receivable._id), 0, 'nothing is owed any more');
  assert.equal(
    await balanceOf(biz, await walletOf(biz, courier)),
    379100,
    'it is in the wallet instead'
  );

  for (const e of await JournalEntry.find({ business: biz._id })) {
    const debit = e.lines.reduce((s, l) => s + l.debitPaisa, 0);
    const credit = e.lines.reduce((s, l) => s + l.creditPaisa, 0);
    assert.equal(debit, credit, `"${e.memo}" balances`);
  }
});

test('a parcel the courier has not paid stays unpaid, and one without a known fee is not recorded', async () => {
  const waiting = await deliveredParcel({ paid: false });
  await recordingOn(await Party.findById(waiting.courier._id));
  assert.equal((await recordCourierWallets()).paid, 0);
  assert.equal((await Order.findById(waiting.order._id)).paymentStatus, 'unpaid');

  // Fee not known: take it away and say it is paid.
  fakePostex({ tracking: { 'CX-1001': DELIVERED }, paid: ['CX-1001'] });
  await Order.updateOne(
    { _id: waiting.order._id },
    { $unset: { deliveryChargePaisa: 1, 'courierBooking.paymentCheckedAt': 1 } }
  );
  assert.equal(
    (await recordCourierWallets()).paid,
    0,
    'its figure would be overstated: left alone'
  );
});

test('a returned parcel’s charge takes the wallet below zero, once', async () => {
  const returned = {
    transactionStatus: 'Returned',
    reversalFee: 120,
    reversalTax: 19,
    transactionStatusHistory: hist(['0006', 'Returned'])
  };
  const { order, courier, biz } = await deliveredParcel({ paid: false, record: returned });
  assert.equal((await Order.findById(order._id)).status, 'returned');
  await recordingOn(await Party.findById(courier._id));

  const receivable = await accountByCode(biz._id, CODES.COD_RECEIVABLE);
  assert.equal(
    await accountBalance(biz._id, receivable._id),
    -13900,
    'the courier is owed less than nothing'
  );

  assert.equal((await recordCourierWallets()).charges, 1);
  const wallet = await walletOf(biz, courier);
  assert.equal(await balanceOf(biz, wallet), -13900, 'the wallet shows a minus');
  assert.equal(await accountBalance(biz._id, receivable._id), 0);

  assert.equal((await recordCourierWallets()).charges, 0, 'not taken twice');
  assert.equal(await balanceOf(biz, wallet), -13900);
});

test('the wallet can not be spent: every payment path refuses it', async () => {
  const { courier, biz } = await deliveredParcel();
  await recordingOn(await Party.findById(courier._id));
  await recordCourierWallets();
  const wallet = await walletOf(biz, courier);

  await assert.rejects(
    resolveMoney(biz._id, { account: String(wallet._id) }, admin),
    err => err.statusCode === 400 && /held by the courier/.test(err.message)
  );
  // …but it is allowed as the place money is moved OUT of.
  const out = await resolveMoney(biz._id, { account: String(wallet._id) }, admin, {
    allowCourierHeld: true
  });
  assert.equal(String(out.account), String(wallet._id));
});

test('Move money takes it out to the bank; moving money INTO the wallet is refused', async () => {
  const { courier, biz } = await deliveredParcel();
  await recordingOn(await Party.findById(courier._id));
  await recordCourierWallets();
  const wallet = await walletOf(biz, courier);
  const bank = await accountByCode(biz._id, CODES.BANK);

  const move = (from, to, amount) =>
    runHandler(recordTransfer, {
      user: admin,
      accessFilter: {},
      body: { business: String(biz._id), from: String(from), to: String(to), amount }
    });

  await move(wallet._id, bank._id, 3000);
  assert.equal(await balanceOf(biz, wallet), 379100 - 300000);
  assert.equal(await accountBalance(biz._id, bank._id), 300000);

  await assert.rejects(move(bank._id, wallet._id, 100), /held by the courier/);
});

test('two runs at once record a parcel once and make one wallet', async () => {
  const { order, courier, biz } = await deliveredParcel();
  await recordingOn(await Party.findById(courier._id));

  await Promise.all([recordCourierWallets(), recordCourierWallets()]);

  assert.equal(await Account.countDocuments({ business: biz._id, courier: courier._id }), 1);
  const wallet = await walletOf(biz, courier);
  assert.equal(await balanceOf(biz, wallet), 379100, 'paid once, not twice');
  assert.equal((await Order.findById(order._id)).paymentStatus, 'paid');
});

test('undoing the entry from the journal puts the parcel back to unpaid', async () => {
  const { order, courier, biz } = await deliveredParcel();
  await recordingOn(await Party.findById(courier._id));
  await recordCourierWallets();
  const entry = await JournalEntry.findById((await Order.findById(order._id)).courierSettlement);

  await runHandler(reverseJournalEntry, { user: admin, resource: entry, body: {} });

  assert.equal((await Order.findById(order._id)).paymentStatus, 'unpaid');
  assert.equal(await balanceOf(biz, await walletOf(biz, courier)), 0);
});

test('turning recording on needs a saved key, and names who turned it on', async () => {
  fakePostex({});
  const { courier } = await setupOrder();
  await recordingOn(await Party.findById(courier._id));
  const link = (await Party.findById(courier._id)).integration;
  assert.equal(link.recordPayments, true);
  assert.equal(String(link.recordPaymentsBy), String(userId));

  await runHandler(saveConnection, {
    user: admin,
    resource: await Party.findById(courier._id),
    body: courierConnectionSchema.parse({ recordPayments: false })
  });
  const off = (await Party.findById(courier._id)).integration;
  assert.equal(off.recordPayments, false);
  assert.equal(off.recordPaymentsBy, undefined);
});

test('if the COD-tax settings change after delivery, the wallet still clears exactly what was booked', async () => {
  const { courier, biz } = await deliveredParcel(); // delivered with no tax: owed 3,791
  await Business.updateOne(
    { _id: biz._id },
    { $set: { codTax: { whtPercent: 5, salesTaxPercent: 5 } } }
  );
  await recordingOn(await Party.findById(courier._id));
  await recordCourierWallets();

  const receivable = await accountByCode(biz._id, CODES.COD_RECEIVABLE);
  assert.equal(await accountBalance(biz._id, receivable._id), 0, 'no residue on the courier');
  assert.equal(await balanceOf(biz, await walletOf(biz, courier)), 379100);
});
