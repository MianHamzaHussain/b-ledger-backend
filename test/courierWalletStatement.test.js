import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, runHandler, userId } from './helpers/db.js';
import Order from '../models/Order.js';
import Party from '../models/Party.js';
import Account from '../models/Account.js';
import { clearCityCache } from '../utils/couriers/booking.js';
import { recordCourierWallets } from '../utils/courierWallet.js';
import { courierWalletFor } from '../utils/moneyAccounts.js';
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { getCourierWallet } from '../controllers/financeController.js';
import { RETURNED, restoreFetch, deliveredParcel, recordingOn } from './helpers/courier.js';

/**
 * The courier's wallet parcel by parcel: which tracking numbers were paid (+) and charged (−), what is still to come,
 * and where the wallet stands. Everything shown is already in the books; nothing is posted by reading it.
 */
before(connect);
after(disconnect);
afterEach(async () => {
  restoreFetch();
  clearCityCache();
  await clear();
});

const statement = async (biz, wallet, query = {}) =>
  (
    await runHandler(getCourierWallet, {
      query: { business: String(biz._id), account: String(wallet._id), ...query },
      accessFilter: {}
    })
  ).body.data;

const walletFor = async (biz, courier) =>
  courierWalletFor(biz._id, await Party.findById(courier._id), userId);

test('a paid parcel is listed with its tracking number and order, as what it paid in', async () => {
  const { order, courier, biz } = await deliveredParcel();
  await recordingOn(await Party.findById(courier._id));
  await recordCourierWallets();

  const out = await statement(biz, await walletFor(biz, courier));
  assert.equal(out.rows.length, 1);
  const [paid] = out.rows;
  assert.equal(paid.kind, 'paid');
  assert.equal(paid.tracking, 'CX-1001');
  assert.equal(String(paid.order), String(order._id));
  assert.equal(paid.orderNumber, order.orderNumber);
  assert.equal(paid.amount, 3791, 'COD 4,000 minus the 209 charge');

  assert.equal(out.inWallet, 3791);
  assert.equal(out.owed, 0);
  assert.equal(out.willGet, 3791);
});

test('a returned parcel is listed as a charge taken off — a minus', async () => {
  const { courier, biz } = await deliveredParcel({ paid: false, record: RETURNED });
  await recordingOn(await Party.findById(courier._id));
  await recordCourierWallets();

  const out = await statement(biz, await walletFor(biz, courier));
  const [charge] = out.rows;
  assert.equal(charge.kind, 'charge');
  assert.equal(charge.reason, 'returned');
  assert.equal(charge.amount, -139);
  assert.equal(out.inWallet, -139);
  assert.equal(out.willGet, -139);
});

test('a delivered parcel the courier has not paid yet is what is still to come', async () => {
  const { courier, biz } = await deliveredParcel({ paid: false });
  const out = await statement(biz, await walletFor(biz, courier));

  const [owed] = out.rows;
  assert.equal(owed.kind, 'owed');
  assert.equal(owed.amount, 3791);
  assert.equal(out.inWallet, 0);
  assert.equal(out.owed, 3791);
  assert.equal(out.willGet, 3791, 'nothing in the wallet yet, but this is coming');
});

test('a charge not yet on the wallet shows as coming off, and lowers what you will get', async () => {
  const { courier, biz } = await deliveredParcel({ paid: false, record: RETURNED });
  const out = await statement(biz, await walletFor(biz, courier));

  const [pending] = out.rows;
  assert.equal(pending.kind, 'charge-pending');
  assert.equal(pending.amount, -139);
  assert.equal(out.charges, 139);
  assert.equal(out.willGet, -139);
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

  const out = await statement(biz, await walletFor(biz, courier));
  assert.equal(out.rows[0].amount, 3791);
});

test('only a courier wallet of this business can be read', async () => {
  const { biz, courier } = await deliveredParcel();
  const cash = await accountByCode(biz._id, CODES.CASH);
  await assert.rejects(statement(biz, cash), /not a courier wallet/);

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
