import ErrorResponse from './errorResponse.js';
import { accountByCode, ensureChart, CODES } from './chartOfAccounts.js';
import { postEntry } from './ledger.js';
import { orderLabel } from './orderPosting.js';
import { releaseStock } from './stock.js';
import { toPaisa, fromPaisa } from './money.js';
import { JOURNAL_SOURCES, ORDER_STATUS } from './constants.js';
import { isCounterSale } from '../models/Order.js';
import { logActivity, rupees } from './orderActivity.js';

/**
 * The customer kept some pieces of a DELIVERED order and sent the others back (R9-13). The standard
 * flows — exchange, swap, refund return — are whole-order and are left exactly as they are; this one
 * reverses only the pieces that came back, with the same entries those flows post, on a subset of lines:
 *
 *   sale → credit     Dr Sales                  Cr Advances from customers   (the returned pieces' price)
 *   goods back        Dr Inventory              Cr COGS                      (the returned pieces' cost)
 *   kept back         Dr Advances               Cr Charges kept from refunds (only if something is kept)
 *
 * The order stays DELIVERED. What the courier collected and charged stands (it happened); what is owed
 * back to the customer is the order's ordinary refund due, paid with the ordinary "Refund paid".
 * An order whose every piece has come back is not partial: it goes through Refund return or Exchange.
 */

/** Only a delivered courier parcel — a counter sale is settled at the counter. */
const assertPartlyReturnable = order => {
  if (order.status !== ORDER_STATUS.DELIVERED) {
    throw new ErrorResponse('Only a delivered order can have items sent back', 400);
  }
  if (order.exchangedFor) throw new ErrorResponse('This order has already been exchanged', 400);
  if (isCounterSale(order)) {
    throw new ErrorResponse('A counter sale is settled at the counter, not here', 400);
  }
};

/** How many pieces of one line have already come back. */
export const returnedOf = (order, lineId) =>
  (order.returnedItems ?? [])
    .filter(r => String(r.line) === String(lineId))
    .reduce((sum, r) => sum + r.quantity, 0);

/** What can still go back on each line, for the dialog: `[{ line, left }]`. */
export const returnableLines = order =>
  order.items.map(item => ({
    line: String(item._id),
    left: item.quantity - returnedOf(order, item._id)
  }));

const entryFor = async (order, { memo, debit, credit, amountPaisa, userId }) => {
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
 * Record some pieces coming back. `lines` is `[{ line, quantity }]` (a line is an order item's id);
 * everything is checked before anything is posted. `keep` (rupees) is held back from the refund.
 */
export const partialReturn = async (order, body, userId) => {
  assertPartlyReturnable(order);
  const { lines = [], returnBy = 'customer', returnCourierName, reversalTrackingId, note } = body;

  // Resolve and check every line first: a bad one must leave nothing half done.
  const picked = [];
  const seen = new Set();
  for (const { line, quantity } of lines) {
    if (seen.has(String(line))) throw new ErrorResponse('A line is listed twice', 400);
    seen.add(String(line));
    const item = order.items.id(line);
    if (!item) throw new ErrorResponse('That item is not on this order', 400);
    const left = item.quantity - returnedOf(order, line);
    if (quantity > left) {
      throw new ErrorResponse(
        left > 0
          ? `Only ${left} of ${item.productName} can still go back`
          : `${item.productName} has already been sent back`,
        400
      );
    }
    picked.push({ item, quantity });
  }
  if (!picked.length) throw new ErrorResponse('Choose which items came back', 400);

  // Every piece back is not "some" — the whole-order flows already do that, with their own rules.
  const piecesBefore = order.items.reduce((s, i) => s + i.quantity, 0);
  const alreadyBack = (order.returnedItems ?? []).reduce((s, r) => s + r.quantity, 0);
  const nowBack = picked.reduce((s, p) => s + p.quantity, 0);
  if (alreadyBack + nowBack >= piecesBefore) {
    throw new ErrorResponse(
      'That is every piece — use Refund return or Exchange for the whole order',
      400
    );
  }

  const amountPaisa = picked.reduce((s, p) => s + toPaisa(p.item.unitPrice) * p.quantity, 0);
  const costPaisa = picked.reduce((s, p) => s + toPaisa(p.item.unitCost) * p.quantity, 0);
  const keepPaisa = toPaisa(body.keep ?? 0);
  if (keepPaisa > amountPaisa) {
    throw new ErrorResponse('You can not keep back more than the returned items cost', 400);
  }

  await ensureChart(order.business);
  const credit = await entryFor(order, {
    memo: 'Items sent back: sale becomes credit',
    debit: CODES.SALES,
    credit: CODES.CUSTOMER_ADVANCES,
    amountPaisa,
    userId
  });
  await releaseStock(
    picked.map(({ item, quantity }) => ({
      product: item.product,
      variantId: item.variantId,
      quantity
    }))
  );
  if (costPaisa > 0) {
    await entryFor(order, {
      memo: 'Items sent back: goods back in stock',
      debit: CODES.INVENTORY,
      credit: CODES.COGS,
      amountPaisa: costPaisa,
      userId
    });
  }

  // The money the customer paid for those pieces is now theirs to get back (the order's refund due).
  order.customerMoney.push({
    kind: 'transfer-in',
    amountPaisa,
    accountName: 'items sent back',
    date: new Date(),
    entry: credit._id,
    by: userId
  });
  if (keepPaisa > 0) {
    const kept = await entryFor(order, {
      memo: 'Items sent back: delivery charge & tax kept',
      debit: CODES.CUSTOMER_ADVANCES,
      credit: CODES.CHARGES_KEPT,
      amountPaisa: keepPaisa,
      userId
    });
    order.customerMoney.push({
      kind: 'kept',
      amountPaisa: keepPaisa,
      accountName: 'delivery charge & tax',
      date: new Date(),
      entry: kept._id,
      by: userId
    });
  }

  const date = new Date();
  for (const { item, quantity } of picked) {
    order.returnedItems.push({
      line: item._id,
      productName: item.productName,
      variantLabel: item.variantLabel,
      quantity,
      unitPrice: item.unitPrice,
      amountPaisa: toPaisa(item.unitPrice) * quantity,
      date,
      by: userId,
      returnBy,
      returnCourierName: returnBy === 'customer' ? returnCourierName : undefined,
      reversalTrackingId,
      note
    });
  }
  order.returnedPieces = alreadyBack + nowBack;
  if (reversalTrackingId) order.reversalTrackingId = reversalTrackingId;
  order.updatedBy = userId;

  const what = picked
    .map(
      ({ item, quantity }) =>
        `${quantity} × ${item.productName}${item.variantLabel && item.variantLabel !== 'Default' ? ` (${item.variantLabel})` : ''}`
    )
    .join(', ');
  logActivity(
    order,
    { id: userId },
    {
      kind: 'money',
      text: `Sent back: ${what} — ${rupees(fromPaisa(amountPaisa))} back to the customer`
    }
  );
  return { amountPaisa, costPaisa, keepPaisa };
};
