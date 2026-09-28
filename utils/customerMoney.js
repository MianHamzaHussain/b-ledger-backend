import ErrorResponse from './errorResponse.js';
import { accountByCode, ensureChart, CODES } from './chartOfAccounts.js';
import { postEntry, reverseEntry } from './ledger.js';
import { orderLabel } from './orderPosting.js';
import { toPaisa } from './money.js';
import { JOURNAL_SOURCES, ORDER_STATUS } from './constants.js';
import { isCounterSale } from '../models/Order.js';
import { upsertCustomerParty } from './customerParty.js';
/**
 * Money that passes directly between the customer and us on an order — an
 * advance (the payment screenshot) or a refund. Each posts on the day it
 * happens, so the money account is right that day, not when the parcel lands:
 *
 *   advance   Dr money account         Cr Advances from customers
 *   refund    Dr Advances from customers   Cr money account
 *
 * Delivery then moves what the sale uses (total − COD) from the liability into
 * the sale. Whatever is held beyond that — an advance that came after the COD
 * was printed, or money on an order that won't be sold — is a refund due.
 */

/** Statuses on which the customer can still pay us. */
const TAKES_ADVANCE = new Set([
  ORDER_STATUS.PENDING,
  ORDER_STATUS.CONFIRMED,
  ORDER_STATUS.DISPATCHED,
  ORDER_STATUS.DELIVERED
]);

/** Statuses whose sale won't use the advance — it is all owed back. */
const NOT_SOLD = new Set([ORDER_STATUS.CANCELLED, ORDER_STATUS.RETURNED, ORDER_STATUS.EXCHANGED]);

const formatRupees = rupees => `Rs ${Number(rupees).toLocaleString('en-PK')}`;
const heldPaisaOf = order =>
  order.customerMoney.reduce(
    (s, m) => s + (m.kind === 'advance' ? m.amountPaisa : -m.amountPaisa),
    0
  );

/**
 * Record an advance the customer sent. Before dispatch it lowers the COD; after
 * it, the COD is fixed, so it becomes a refund due (the courier still collects
 * the full COD).
 */
export const recordAdvance = async (order, { amount, money, date, note, userId }) => {
  if (isCounterSale(order)) {
    throw new ErrorResponse("A counter sale's payments go on the customer's khata", 400);
  }
  if (!TAKES_ADVANCE.has(order.status)) {
    throw new ErrorResponse(`A ${order.status} order can't take an advance`, 400);
  }
  const amountPaisa = toPaisa(amount);
  const totalPaisa = toPaisa(order.total);
  const isBeforeDispatch =
    order.status === ORDER_STATUS.PENDING || order.status === ORDER_STATUS.CONFIRMED;
  if (isBeforeDispatch && heldPaisaOf(order) + amountPaisa > totalPaisa) {
    throw new ErrorResponse(
      `That would be more than the order total (${formatRupees(order.total)})`,
      400
    );
  }

  await ensureChart(order.business);
  const advances = await accountByCode(order.business, CODES.CUSTOMER_ADVANCES);
  const label = `${orderLabel(order)} · ${order.customerName}`;
  const entry = await postEntry({
    business: order.business,
    date,
    memo: note ? `Advance — ${label} — ${note}` : `Advance — ${label}`,
    source: { kind: JOURNAL_SOURCES.ORDER_ADVANCE, ref: String(order._id) },
    lines: [
      { account: money.account, label, debitPaisa: amountPaisa },
      { account: advances._id, label, creditPaisa: amountPaisa }
    ],
    userId
  });

  order.customerMoney.push(rowOf('advance', amountPaisa, money, { date, note, entry, userId }));
  order.updatedBy = userId;
  await order.save();
  return order;
};

/** Pay the customer back — at most what is due to them. */
export const recordRefund = async (order, { amount, money, date, note, userId }) => {
  const amountPaisa = toPaisa(amount);
  if (amountPaisa > order.refundDuePaisa) {
    throw new ErrorResponse(
      order.refundDuePaisa > 0
        ? `Only ${formatRupees(order.refundDuePaisa / 100)} is due back on this order`
        : 'Nothing is due back on this order',
      400
    );
  }

  await ensureChart(order.business);
  const advances = await accountByCode(order.business, CODES.CUSTOMER_ADVANCES);
  const label = `${orderLabel(order)} · ${order.customerName}`;
  const entry = await postEntry({
    business: order.business,
    date,
    memo: note ? `Refund — ${label} — ${note}` : `Refund — ${label}`,
    source: { kind: JOURNAL_SOURCES.ORDER_REFUND, ref: String(order._id) },
    lines: [
      { account: advances._id, label, debitPaisa: amountPaisa },
      { account: money.account, label, creditPaisa: amountPaisa }
    ],
    userId
  });

  order.customerMoney.push(rowOf('refund', amountPaisa, money, { date, note, entry, userId }));
  order.updatedBy = userId;
  await order.save();
  return order;
};

/**
 * Take back an advance or refund entered by mistake: its entry is reversed and
 * the row removed. Refused when the money is already spoken for — an advance
 * the sale uses (the COD was printed without it) can't disappear.
 */
export const removeCustomerMoney = async (order, rowId, userId) => {
  const row = order.customerMoney.id(rowId);
  if (!row) throw new ErrorResponse('That payment is not on this order', 404);

  const heldAfter = heldPaisaOf(order) + (row.kind === 'advance' ? -1 : 1) * row.amountPaisa;
  if (heldAfter < 0) {
    throw new ErrorResponse('Remove the refund first — it paid back this advance', 400);
  }
  const frozen = !(
    order.status === ORDER_STATUS.PENDING || order.status === ORDER_STATUS.CONFIRMED
  );
  const usedPaisa =
    frozen && !NOT_SOLD.has(order.status) ? toPaisa(order.total) - toPaisa(order.codAmount) : 0;
  if (row.kind === 'advance' && heldAfter < usedPaisa) {
    throw new ErrorResponse(
      'The COD was fixed with this advance taken off, so it can no longer be removed',
      400
    );
  }

  await reverseEntry(row.entry, {
    userId,
    memo: `Removed ${row.kind} — ${orderLabel(order)}`
  });
  row.deleteOne();
  order.updatedBy = userId;
  await order.save();
  return order;
};

const rowOf = (kind, amountPaisa, money, { date, note, entry, userId }) => ({
  kind,
  amountPaisa,
  account: money.partner ? undefined : money.account,
  partner: money.partner,
  accountName: money.partner ? `${money.name} (partner)` : money.name,
  date: date || new Date(),
  note,
  entry: entry._id,
  by: userId
});

/** Keep what's due as credit on the customer's khata instead of paying it back. */
export const keepAsCredit = async (order, { amount, userId }) => {
  if (!NOT_SOLD.has(order.status)) {
    throw new ErrorResponse('Only a cancelled or returned order can keep money as credit', 400);
  }
  const amountPaisa = toPaisa(amount);
  if (amountPaisa <= 0 || amountPaisa > order.refundDuePaisa) {
    throw new ErrorResponse('Nothing that much is due back on this order', 400);
  }
  const party = await upsertCustomerParty(
    order.business,
    order.customerName,
    order.contactNumber,
    userId
  );
  await ensureChart(order.business);
  const advances = await accountByCode(order.business, CODES.CUSTOMER_ADVANCES);
  const receivable = await accountByCode(order.business, CODES.ACCOUNTS_RECEIVABLE);
  const label = `${orderLabel(order)} · ${order.customerName}`;
  const entry = await postEntry({
    business: order.business,
    memo: `Kept as credit — ${label}`,
    source: { kind: JOURNAL_SOURCES.ORDER_REFUND, ref: String(order._id) },
    lines: [
      { account: advances._id, label, debitPaisa: amountPaisa },
      { account: receivable._id, party, label, creditPaisa: amountPaisa }
    ],
    userId
  });
  order.customerParty = order.customerParty || party;
  order.customerMoney.push({
    kind: 'credit',
    amountPaisa,
    accountName: 'Credit on khata',
    date: new Date(),
    entry: entry._id,
    by: userId
  });
  order.updatedBy = userId;
  await order.save();
  return order;
};
