import ErrorResponse from './errorResponse.js';
import { accountByCode, ensureChart, CODES } from './chartOfAccounts.js';
import { postEntry } from './ledger.js';
import { orderLabel } from './orderPosting.js';
import { costsFor } from './courierCosts.js';
import { toPaisa } from './money.js';
import { JOURNAL_SOURCES, ORDER_STATUS } from './constants.js';
import { isCounterSale } from '../models/Order.js';
import { convertSaleToCredit, receiveReturnedGoods } from './exchange.js';
import { putScratchInStock } from './scratchStock.js';

/**
 * A delivered order the customer sends back for their money ("I don't like it").
 * Like an exchange, what happened stands — the courier delivered, collected the
 * COD and charged us — so only the sale turns into the customer's credit and the
 * goods go back into stock. Then, unlike an exchange, the credit is owed back:
 *
 *   sale → credit        Dr Sales               Cr Advances from customers
 *   goods back           Dr Inventory           Cr COGS
 *   courier costs kept   Dr Advances            Cr Charges kept from refunds   (at payout, see courierCosts.js)
 *   our shipping share   Dr Return charges      Cr Advances
 *
 * What's left in Advances is the refund due, paid with the order's "Refund paid".
 *
 * Normally the customer ships it back on their own courier — named here only for
 * reference; it never appears on our invoice. Rarely we book the pickup on our
 * courier (charged on its invoice, and deducted from the refund).
 */

/** Only a delivered courier parcel is refunded here — a counter sale is settled at the counter. */
const assertRefundable = order => {
  if (order.status !== ORDER_STATUS.DELIVERED) {
    throw new ErrorResponse('Only a delivered order can be sent back for a refund', 400);
  }
  if (order.exchangedFor) throw new ErrorResponse('This order has already been exchanged', 400);
  if (order.returnedItems?.length) {
    throw new ErrorResponse(
      'Part of this order was already sent back — the rest can only go back piece by piece',
      400
    );
  }
  if (isCounterSale(order)) {
    throw new ErrorResponse('A counter sale is refunded at the counter, not here', 400);
  }
};

/**
 * What a refund would pay back and why: everything the customer paid, less the courier's costs for the parcels
 * (utils/courierCosts.js) — the delivery charge and the COD tax, and the pickup when WE booked it on our courier.
 * `isFinal` is false until PostEx has billed every parcel; the payout waits for it (or an admin pays early).
 * Once settled the lines are the ones that were kept back.
 */
export const refundQuote = async (order, { returnBy } = {}) => {
  const isReplacement = Boolean(order.exchangeOf);
  const settled = order.courierCosts?.settledAt;
  const costs = settled
    ? {
        lines: (order.courierCosts.lines || []).map(l => ({ ...l, isFinal: true })),
        totalPaisa: (order.courierCosts.lines || []).reduce((sum, l) => sum + l.amountPaisa, 0),
        isFinal: true,
        waitingFor: []
      }
    : await costsFor(order, { asRefund: !isReplacement, pickupBy: returnBy });
  // A refunded order owes back everything the customer paid. A replacement owes back what its credit leaves after
  // the replacement's own price (its refund due) — before the costs, which are taken off at payout.
  const paidPaisa = isReplacement
    ? order.refundDuePaisa + (settled && !order.courierCosts.waived ? costs.totalPaisa : 0)
    : toPaisa(order.total);
  // Our agreed share of the customer's own return shipping is paid back on top (kind `shipping`).
  const sharePaisa = (order.customerMoney || [])
    .filter(m => m.kind === 'shipping')
    .reduce((sum, m) => sum + m.amountPaisa, 0);
  return {
    paidPaisa,
    sharePaisa,
    lines: costs.lines,
    totalCostPaisa: costs.totalPaisa,
    netRefundPaisa: paidPaisa + (isReplacement ? 0 : sharePaisa) - costs.totalPaisa,
    isFinal: costs.isFinal,
    waitingFor: costs.waitingFor,
    settled: Boolean(settled),
    waived: Boolean(order.courierCosts?.waived),
    reason: order.courierCosts?.reason ?? null
  };
};

const postCustomerMoneyEntry = async (order, { memo, debit, credit, amountPaisa, userId }) => {
  const label = `${orderLabel(order)} · ${order.customerName}`;
  return postEntry({
    business: order.business,
    memo: `${memo} — ${label}`,
    source: { kind: JOURNAL_SOURCES.ORDER, ref: String(order._id) },
    lines: [
      { account: (await accountByCode(order.business, debit))._id, label, debitPaisa: amountPaisa },
      {
        account: (await accountByCode(order.business, credit))._id,
        label,
        creditPaisa: amountPaisa
      }
    ],
    userId
  });
};

/**
 * Record the item coming back for a refund. Nothing is typed in to hold back: the courier's costs are taken off by
 * `settleCourierCosts` at payout, once PostEx has billed them. `shippingShare` (rupees) is only our part of the
 * customer's OWN return shipping, paid back on top.
 */
export const refundReturn = async (order, body, userId) => {
  assertRefundable(order);
  const { returnBy, returnCourierName, reversalTrackingId, scratchPieces } = body;
  // Only our share of the customer's OWN return shipping is typed. The courier's costs come from PostEx.
  const sharePaisa = returnBy === 'customer' ? toPaisa(body.shippingShare ?? 0) : 0;

  await ensureChart(order.business);
  await convertSaleToCredit(order, userId, 'Refund');
  await receiveReturnedGoods(order, userId, 'Refund');
  // Delivered, so a made-from-scratch piece's cost is in COGS — it comes back out.
  await putScratchInStock(order, scratchPieces, userId, { fromCogs: true });

  if (sharePaisa > 0) {
    const entry = await postCustomerMoneyEntry(order, {
      memo: 'Refund — our share of return shipping',
      debit: CODES.RETURN_CHARGES,
      credit: CODES.CUSTOMER_ADVANCES,
      amountPaisa: sharePaisa,
      userId
    });
    order.customerMoney.push({
      kind: 'shipping',
      amountPaisa: sharePaisa,
      accountName: 'our share of their return shipping',
      date: new Date(),
      entry: entry._id,
      by: userId
    });
  }

  order.returnShipping = {
    by: returnBy,
    courierName: returnBy === 'customer' ? returnCourierName : undefined,
    sharePaisa: sharePaisa || undefined
  };
  if (reversalTrackingId) order.reversalTrackingId = reversalTrackingId;
  // Their own courier: nothing will ever come on our invoice for it.
  if (returnBy === 'customer') order.returnChargePaisa = 0;
  order.status = ORDER_STATUS.REFUNDED;
  order.updatedBy = userId;
};
