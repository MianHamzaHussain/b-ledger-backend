import ErrorResponse from './errorResponse.js';
import { accountByCode, ensureChart, CODES } from './chartOfAccounts.js';
import { postEntry } from './ledger.js';
import { cogsPaisaOf, orderLabel } from './orderPosting.js';
import { releaseStock } from './stock.js';
import { toPaisa } from './money.js';
import { JOURNAL_SOURCES, ORDER_STATUS } from './constants.js';
import { heldPaisaOf, isCounterSale } from '../models/Order.js';

/**
 * An exchange, in money terms. The customer paid for the original (advance +
 * the COD the courier collected); that payment is not refunded — it becomes a
 * credit that the replacement uses, so the replacement's COD is only the price
 * difference (or 0, as couriers print it for a like-for-like swap).
 *
 * What already happened stays booked: the courier did deliver and collect, so
 * its COD receivable, delivery charge and the FBR taxes are untouched. Only the
 * sale turns into credit, and the goods — when they are back — into stock:
 *
 *   sale → credit     Dr Sales                     Cr Advances from customers
 *   goods back        Dr Inventory                 Cr COGS
 *
 * Return-first does both when the old item arrives. Swap at the door converts
 * the sale at once (the replacement needs the credit on its COD) and takes the
 * goods back when the reversal parcel arrives.
 */

/** Only a delivered courier parcel is exchanged here — a counter sale changes at the counter. */
export const assertExchangeable = order => {
  if (order.status !== ORDER_STATUS.DELIVERED) {
    throw new ErrorResponse('Only a delivered order can be exchanged', 400);
  }
  if (order.exchangedFor) throw new ErrorResponse('This order has already been exchanged', 400);
  if (isCounterSale(order)) {
    throw new ErrorResponse('A counter sale is exchanged at the counter, not here', 400);
  }
};

/**
 * Turn the original's sale into the customer's credit. The order then holds
 * everything the customer paid for it — its advances plus the COD — as money
 * waiting for the replacement.
 */
export const convertSaleToCredit = async (order, userId, reason = 'Exchange') => {
  const totalPaisa = toPaisa(order.total);
  const codPaisa = toPaisa(order.codAmount);
  let entry = null;
  if (order.saleEntry && totalPaisa > 0) {
    await ensureChart(order.business);
    const label = `${orderLabel(order)} · ${order.customerName}`;
    entry = await postEntry({
      business: order.business,
      memo: `${reason} — ${label}: sale becomes credit`,
      source: { kind: JOURNAL_SOURCES.ORDER, ref: String(order._id) },
      lines: [
        {
          account: (await accountByCode(order.business, CODES.SALES))._id,
          label,
          debitPaisa: totalPaisa
        },
        {
          account: (await accountByCode(order.business, CODES.CUSTOMER_ADVANCES))._id,
          label,
          creditPaisa: totalPaisa
        }
      ],
      userId
    });
    // The advances were already held (and used by the sale); what the customer
    // paid on the door is the new part of the credit. A transfer row: it can't
    // be removed on its own — it came from undoing the sale.
    if (codPaisa > 0) {
      order.customerMoney.push({
        kind: 'transfer-in',
        amountPaisa: codPaisa,
        accountName: 'paid on delivery',
        date: new Date(),
        entry: entry._id,
        by: userId
      });
    }
  }
  order.status = ORDER_STATUS.EXCHANGED;
  order.updatedBy = userId;
  return entry;
};

/** The old item is back: its stock returns and its cost comes off the sale's COGS. */
export const receiveReturnedGoods = async (order, userId, reason = 'Exchange') => {
  await releaseStock(order.items);
  const cogsPaisa = cogsPaisaOf(order);
  if (cogsPaisa > 0) {
    await ensureChart(order.business);
    const label = orderLabel(order);
    await postEntry({
      business: order.business,
      memo: `${reason} — ${label}: goods back in stock`,
      source: { kind: JOURNAL_SOURCES.ORDER, ref: String(order._id) },
      lines: [
        {
          account: (await accountByCode(order.business, CODES.INVENTORY))._id,
          label,
          debitPaisa: cogsPaisa
        },
        {
          account: (await accountByCode(order.business, CODES.COGS))._id,
          label,
          creditPaisa: cogsPaisa
        }
      ],
      userId
    });
  }
  order.awaitingReturn = false;
};

/**
 * The credit the replacement starts with — everything the original holds for
 * the customer. Put it on the replacement when creating it (no entry: the money
 * already sits in Advances from customers), then call `markCreditMoved`.
 */
export const creditForReplacement = (original, userId) => {
  const heldPaisa = heldPaisaOf(original);
  if (heldPaisa <= 0) return null;
  return {
    kind: 'transfer-in',
    amountPaisa: heldPaisa,
    accountName: `from exchange of #${original.orderNumber}`,
    date: new Date(),
    by: userId
  };
};

/** The original no longer holds the credit — its replacement does. */
export const markCreditMoved = (original, replacement, amountPaisa, userId) => {
  original.customerMoney.push({
    kind: 'transfer-out',
    amountPaisa,
    accountName: `moved to replacement #${replacement.orderNumber}`,
    date: new Date(),
    by: userId
  });
  original.exchangedFor = replacement._id;
  original.updatedBy = userId;
};
