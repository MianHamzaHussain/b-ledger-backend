import Business from '../models/Business.js';
import ErrorResponse from './errorResponse.js';
import { accountByCode, ensureChart, CODES } from './chartOfAccounts.js';
import { postEntry } from './ledger.js';
import { computeRemittance, orderLabel } from './orderPosting.js';
import { toPaisa } from './money.js';
import { JOURNAL_SOURCES, ORDER_STATUS } from './constants.js';
import { heldPaisaOf, isCounterSale } from '../models/Order.js';
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
 *   kept back            Dr Advances            Cr Charges kept from refunds
 *   our shipping share   Dr Return charges      Cr Advances
 *
 * What's left in Advances is the refund due, paid with the order's "Refund paid".
 *
 * Normally the customer ships it back on their own courier — named here only for
 * reference; it never appears on our invoice. Rarely we book the pickup on our
 * courier (charged on its invoice). Either side may agree to carry part of the
 * other's cost.
 */

/** Only a delivered courier parcel is refunded here — a counter sale is settled at the counter. */
const assertRefundable = order => {
  if (order.status !== ORDER_STATUS.DELIVERED) {
    throw new ErrorResponse('Only a delivered order can be sent back for a refund', 400);
  }
  if (order.exchangedFor) throw new ErrorResponse('This order has already been exchanged', 400);
  if (isCounterSale(order)) {
    throw new ErrorResponse('A counter sale is refunded at the counter, not here', 400);
  }
};

/**
 * What's normally kept back: the courier's delivery charge (if billed yet) and
 * the FBR taxes withheld on the COD. The charge often isn't known until the
 * courier's invoice, so the caller shows it as unknown and the owner types it.
 */
export const refundQuote = async order => {
  const business = await Business.findById(order.business).select('codTax');
  const { whtPaisa, salesTaxPaisa } = computeRemittance(
    toPaisa(order.codAmount),
    order.deliveryChargePaisa ?? 0,
    business?.codTax || {}
  );
  const taxPaisa = whtPaisa + salesTaxPaisa;
  const deliveryChargePaisa = order.deliveryChargePaisa ?? null;
  return {
    paidPaisa: toPaisa(order.total),
    deliveryChargePaisa,
    taxPaisa,
    keepPaisa: (deliveryChargePaisa ?? 0) + taxPaisa
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
 * Record the item coming back for a refund. `keep` (rupees) is held back from
 * the refund; `shippingShare` is our part of the customer's shipping (returnBy
 * customer) or their part of our pickup (returnBy us).
 */
export const refundReturn = async (order, body, userId) => {
  assertRefundable(order);
  const { returnBy, returnCourierName, reversalTrackingId, scratchPieces } = body;
  const keepPaisa = toPaisa(body.keep ?? 0);
  const sharePaisa = toPaisa(body.shippingShare ?? 0);

  await ensureChart(order.business);
  await convertSaleToCredit(order, userId, 'Refund');
  await receiveReturnedGoods(order, userId, 'Refund');
  // Delivered, so a made-from-scratch piece's cost is in COGS — it comes back out.
  await putScratchInStock(order, scratchPieces, userId, { fromCogs: true });

  const heldPaisa = heldPaisaOf(order);
  const theirSharePaisa = returnBy === 'us' ? sharePaisa : 0;
  if (keepPaisa + theirSharePaisa > heldPaisa) {
    throw new ErrorResponse('You can not keep back more than the customer paid', 400);
  }

  const kept = [
    { amountPaisa: keepPaisa, accountName: 'delivery charge & tax' },
    { amountPaisa: theirSharePaisa, accountName: 'their share of the return pickup' }
  ];
  for (const k of kept) {
    if (k.amountPaisa <= 0) continue;
    const entry = await postCustomerMoneyEntry(order, {
      memo: `Refund — ${k.accountName}`,
      debit: CODES.CUSTOMER_ADVANCES,
      credit: CODES.CHARGES_KEPT,
      amountPaisa: k.amountPaisa,
      userId
    });
    order.customerMoney.push({
      kind: 'kept',
      ...k,
      date: new Date(),
      entry: entry._id,
      by: userId
    });
  }

  if (returnBy === 'customer' && sharePaisa > 0) {
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
