import crypto from 'node:crypto';
import Order from '../models/Order.js';
import Party from '../models/Party.js';
import Business from '../models/Business.js';
import JournalEntry from '../models/JournalEntry.js';
import { adapterFor } from './couriers/index.js';
import { courierWalletFor } from './moneyAccounts.js';
import { accountByCode, ensureChart, CODES } from './chartOfAccounts.js';
import { postEntry } from './ledger.js';
import { computeRemittance } from './orderPosting.js';
import { notify } from './notify.js';
import { toPaisa, fromPaisa } from './money.js';
import {
  JOURNAL_SOURCES,
  NOTIFICATION_TYPES,
  ORDER_STATUS,
  PARTY_TYPES,
  PAYMENT_STATUS
} from './constants.js';
import logger from './logger.js';

/**
 * The courier's wallet — money the courier holds for the shop (R9-6). Only for a courier whose connection has
 * `recordPayments` on, which an admin switches on after checking the first batch against the courier's own
 * statement: the amount is CALCULATED (the courier's call says only paid / not paid), not read from it.
 *
 *   a parcel is paid      Dr Courier wallet   Cr COD receivable [courier]      (COD − fee − taxes, as booked at delivery)
 *   a charge is taken     Dr COD receivable   Cr Courier wallet                (a returned parcel's fee: the wallet can go minus)
 *
 * Both are posted against the courier's existing COD receivable, so the courier's Khata and the courier-invoice
 * screens keep working; nothing in the standard Delivered / Returned code changes. The wallet is never
 * spent from — it is moved to the bank or cash with Move money.
 */
const PER_RUN = 40;
const RECHECK_MS = 3 * 60 * 60 * 1000;
const CLAIM_MS = 10 * 60 * 1000;

/**
 * What the courier will pay for a delivered parcel: the receivable booked AT DELIVERY (paisa), read from that
 * entry — so the receivable returns to exactly zero even if the business's COD-tax settings changed since.
 * Only if the entry cannot be found is it recomputed from the order.
 */
const netOwed = (order, codTax, bookedBy) => {
  const entry = bookedBy.get(String(order.saleEntry));
  const line = entry?.lines.find(
    l => String(l.party) === String(order.courier) && (l.debitPaisa || l.creditPaisa)
  );
  if (line) return line.debitPaisa - line.creditPaisa;
  return computeRemittance(toPaisa(order.codAmount), order.deliveryChargePaisa || 0, codTax || {})
    .bankPaisa;
};

/**
 * Ask the courier which delivered parcels it has paid, and record those into its wallet in ONE entry. A parcel
 * whose fee is not known yet is left alone (its figure would be overstated). Returns a tally for the log.
 */
const recordPaidParcels = async (party, api, userId, now) => {
  const business = party.business;
  const tally = { checked: 0, paid: 0, paidPaisa: 0 };
  const candidates = await Order.find({
    business,
    courier: party._id,
    status: ORDER_STATUS.DELIVERED,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    codAmount: { $gt: 0 },
    deliveryChargePaisa: { $exists: true, $ne: null },
    'courierBooking.trackingNumber': { $exists: true },
    $or: [
      { 'courierBooking.paymentCheckedAt': { $exists: false } },
      { 'courierBooking.paymentCheckedAt': { $lt: new Date(now.getTime() - RECHECK_MS) } }
    ]
  })
    .sort({ 'courierBooking.paymentCheckedAt': 1, deliveredAt: -1 })
    .limit(PER_RUN);

  const settled = [];
  for (const order of candidates) {
    tally.checked += 1;
    try {
      const answer = await api.paymentStatus(order.courierBooking.trackingNumber);
      await Order.updateOne(
        { _id: order._id },
        { $set: { 'courierBooking.paymentCheckedAt': now } },
        { timestamps: false }
      );
      if (answer.settled) settled.push(order);
    } catch (err) {
      logger.warn(
        { tracking: order.courierBooking.trackingNumber, err: err.message },
        'payment status not read'
      );
    }
  }
  if (!settled.length) return tally;

  // Claim these parcels in one conditional write: two runs (or a manual invoice) can not pay one twice.
  const token = crypto.randomUUID();
  await Order.updateMany(
    {
      _id: { $in: settled.map(o => o._id) },
      paymentStatus: PAYMENT_STATUS.UNPAID,
      $or: [
        { 'courierBooking.settleClaimedAt': { $exists: false } },
        { 'courierBooking.settleClaimedAt': { $lt: new Date(now.getTime() - CLAIM_MS) } }
      ]
    },
    { $set: { 'courierBooking.settleClaim': token, 'courierBooking.settleClaimedAt': now } },
    { timestamps: false }
  );
  const claimed = await Order.find({ 'courierBooking.settleClaim': token });
  if (!claimed.length) return tally;

  try {
    const biz = await Business.findById(business).select('codTax').lean();
    const sales = await JournalEntry.find({
      _id: { $in: claimed.map(o => o.saleEntry).filter(Boolean) }
    });
    const bookedBy = new Map(sales.map(e => [String(e._id), e]));
    const totalPaisa = claimed.reduce(
      (sum, o) => sum + Math.max(0, netOwed(o, biz?.codTax, bookedBy)),
      0
    );
    await ensureChart(business);
    const wallet = await courierWalletFor(business, party, userId);
    const receivable = await accountByCode(business, CODES.COD_RECEIVABLE);
    const entry = await postEntry({
      business,
      date: now,
      memo: `${party.name} paid ${claimed.length} parcel${claimed.length === 1 ? '' : 's'} — expected amount`,
      source: { kind: JOURNAL_SOURCES.COURIER_INVOICE, ref: String(party._id) },
      lines: [
        { account: wallet._id, debitPaisa: totalPaisa },
        { account: receivable._id, party: party._id, creditPaisa: totalPaisa }
      ],
      userId
    });
    await Order.updateMany(
      { 'courierBooking.settleClaim': token },
      {
        $set: {
          paymentStatus: PAYMENT_STATUS.PAID,
          courierSettlement: entry._id,
          'courierBooking.codSettledAt': now
        },
        $unset: { 'courierBooking.settleClaim': 1, 'courierBooking.settleClaimedAt': 1 }
      },
      { timestamps: false }
    );
    tally.paid = claimed.length;
    tally.paidPaisa = totalPaisa;

    await notify({
      business,
      type: NOTIFICATION_TYPES.COURIER_PAID,
      title: `${party.name} paid ${claimed.length} parcel${claimed.length === 1 ? '' : 's'} — Rs ${fromPaisa(totalPaisa).toLocaleString('en-PK')} is in the ${wallet.name}`,
      body: 'It is the expected amount (COD − fee − taxes). Compare it with the courier’s statement.',
      link: '/finance'
    });
  } catch (err) {
    // Nothing was posted that matters: release the parcels so the next run can try again.
    await Order.updateMany(
      { 'courierBooking.settleClaim': token },
      { $unset: { 'courierBooking.settleClaim': 1, 'courierBooking.settleClaimedAt': 1 } },
      { timestamps: false }
    );
    throw err;
  }
  return tally;
};

/**
 * A returned parcel's fee: the standard Returned posting already booked it against what the courier owes us
 * (so its receivable sits below zero). Mirror the courier's own way of settling it — it takes the charge from
 * its balance — by moving that amount onto the wallet, which then shows a minus until the next payout nets it off.
 */
const recordReturnCharges = async (party, userId, now) => {
  const orders = await Order.find({
    business: party.business,
    courier: party._id,
    status: ORDER_STATUS.RETURNED,
    returnChargePaisa: { $gt: 0 },
    'courierBooking.walletChargeEntry': { $exists: false },
    'courierBooking.trackingNumber': { $exists: true }
  }).limit(PER_RUN);
  if (!orders.length) return 0;

  const token = crypto.randomUUID();
  await Order.updateMany(
    {
      _id: { $in: orders.map(o => o._id) },
      'courierBooking.walletChargeEntry': { $exists: false },
      $or: [
        { 'courierBooking.chargeClaimedAt': { $exists: false } },
        { 'courierBooking.chargeClaimedAt': { $lt: new Date(now.getTime() - CLAIM_MS) } }
      ]
    },
    { $set: { 'courierBooking.chargeClaim': token, 'courierBooking.chargeClaimedAt': now } },
    { timestamps: false }
  );
  const claimed = await Order.find({ 'courierBooking.chargeClaim': token });
  if (!claimed.length) return 0;

  try {
    const totalPaisa = claimed.reduce((sum, o) => sum + o.returnChargePaisa, 0);
    await ensureChart(party.business);
    const wallet = await courierWalletFor(party.business, party, userId);
    const receivable = await accountByCode(party.business, CODES.COD_RECEIVABLE);
    const entry = await postEntry({
      business: party.business,
      date: now,
      memo: `${party.name} took the charge for ${claimed.length} returned parcel${claimed.length === 1 ? '' : 's'}`,
      source: { kind: JOURNAL_SOURCES.COURIER_INVOICE, ref: String(party._id) },
      lines: [
        { account: receivable._id, party: party._id, debitPaisa: totalPaisa },
        { account: wallet._id, creditPaisa: totalPaisa }
      ],
      userId
    });
    await Order.updateMany(
      { 'courierBooking.chargeClaim': token },
      {
        $set: { 'courierBooking.walletChargeEntry': entry._id },
        $unset: { 'courierBooking.chargeClaim': 1, 'courierBooking.chargeClaimedAt': 1 }
      },
      { timestamps: false }
    );
    return claimed.length;
  } catch (err) {
    await Order.updateMany(
      { 'courierBooking.chargeClaim': token },
      { $unset: { 'courierBooking.chargeClaim': 1, 'courierBooking.chargeClaimedAt': 1 } },
      { timestamps: false }
    );
    throw err;
  }
};

/**
 * One pass over every courier that has recording switched on: paid parcels into its wallet, then returned
 * parcels' charges out of it. One courier's failure never stops the others.
 */
export const recordCourierWallets = async ({ now = new Date() } = {}) => {
  const parties = await Party.find({
    type: PARTY_TYPES.COURIER,
    'integration.provider': { $exists: true },
    'integration.recordPayments': true,
    'integration.recordPaymentsBy': { $exists: true }
  });

  const tally = {
    couriers: parties.length,
    checked: 0,
    paid: 0,
    paidPaisa: 0,
    charges: 0,
    errors: 0
  };
  for (const party of parties) {
    const userId = party.integration.recordPaymentsBy;
    try {
      const { api } = await adapterFor(party._id);
      const t = await recordPaidParcels(party, api, userId, now);
      tally.checked += t.checked;
      tally.paid += t.paid;
      tally.paidPaisa += t.paidPaisa;
      tally.charges += await recordReturnCharges(party, userId, now);
    } catch (err) {
      tally.errors += 1;
      logger.error({ courier: String(party._id), err }, 'courier wallet not updated');
    }
  }
  return tally;
};
