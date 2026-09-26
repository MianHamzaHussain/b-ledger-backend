import Order from '../models/Order.js';
import Business from '../models/Business.js';
import { accountByCode, ensureChart, CODES } from './chartOfAccounts.js';
import { postEntry, partyAccountBalance } from './ledger.js';
import { computeRemittance } from './orderPosting.js';
import { methodCode } from './partyPosting.js';
import { toPaisa } from './money.js';
import { JOURNAL_SOURCES, ORDER_STATUS, PAYMENT_STATUS } from './constants.js';

/**
 * A courier's lump-sum payment — "TCS paid 45,000 this week" — booked once and
 * applied to that courier's orders, so nobody marks thirty orders paid by hand.
 *
 * The money is one entry: Dr Bank/Cash  Cr COD-receivable [courier]. Which
 * orders it paid is then worked out from what the courier STILL owes after it,
 * not from the amount alone — because the courier has already kept its return
 * and pickup charges out of the money (those were booked against its balance
 * when the parcels came back). Paying oldest first, an order is marked paid only
 * if the orders left unpaid still account for everything the courier owes. So:
 *
 *   • the courier clears its whole balance  → every delivered order is paid;
 *   • it pays part                          → the oldest orders it covers are
 *                                             paid, the rest stay unpaid;
 *   • it overpays                           → all paid, the extra stays on its
 *                                             account as credit.
 *
 * An order is never part-paid here: one the money doesn't fully cover is left
 * for the next settlement.
 */

/** A courier order's net — what the courier owes for it after fee and taxes. */
const netPaisaOf = (order, codTax) =>
  computeRemittance(toPaisa(order.codAmount), order.deliveryChargePaisa || 0, codTax).bankPaisa;

export const settleCourier = async (courier, paisa, { method, date, memo, userId }) => {
  const business = courier.business;
  await ensureChart(business);
  const cod = await accountByCode(business, CODES.COD_RECEIVABLE);
  const money = await accountByCode(business, methodCode(method));

  const entry = await postEntry({
    business,
    date,
    memo: memo || `Payment from ${courier.name}`,
    source: { kind: JOURNAL_SOURCES.COURIER_SETTLEMENT, ref: String(courier._id) },
    lines: [
      { account: money._id, debitPaisa: paisa },
      { account: cod._id, party: courier._id, creditPaisa: paisa }
    ],
    userId
  });

  // What the courier still owes after this payment.
  const owedAfter = await partyAccountBalance(business, cod._id, courier._id);

  const orders = await Order.find({
    business,
    courier: courier._id,
    status: ORDER_STATUS.DELIVERED,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    paymentEntry: null
  })
    .sort({ createdAt: 1 })
    .select('codAmount deliveryChargePaisa');

  const biz = await Business.findById(business).select('codTax');
  const nets = orders.map(o => netPaisaOf(o, biz?.codTax || {}));
  let unpaidTotal = nets.reduce((s, n) => s + n, 0);

  const paidIds = [];
  for (const [i, order] of orders.entries()) {
    if (unpaidTotal - nets[i] < owedAfter) break;
    paidIds.push(order._id);
    unpaidTotal -= nets[i];
  }

  if (paidIds.length) {
    await Order.updateMany(
      { _id: { $in: paidIds }, paymentStatus: PAYMENT_STATUS.UNPAID },
      { $set: { paymentStatus: PAYMENT_STATUS.PAID, courierSettlement: entry._id } }
    );
  }

  return { entry, settledOrders: paidIds.length, unpaidOrders: orders.length - paidIds.length };
};

/**
 * Undo a settlement's effect on orders — called when its entry is reversed, so
 * the orders it paid read as unpaid again and the courier's statement and the
 * orders never disagree.
 */
export const unsettleCourier = entryId =>
  Order.updateMany(
    { courierSettlement: entryId },
    { $set: { paymentStatus: PAYMENT_STATUS.UNPAID }, $unset: { courierSettlement: '' } }
  );
