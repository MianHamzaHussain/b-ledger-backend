import ErrorResponse from './errorResponse.js';
import { accountByCode, ensureChart, CODES } from './chartOfAccounts.js';
import { postEntry } from './ledger.js';
import { orderLabel } from './orderPosting.js';
import { releaseStock } from './stock.js';
import { toPaisa, fromPaisa } from './money.js';
import { JOURNAL_SOURCES, ORDER_STATUS } from './constants.js';
import { isCounterSale } from '../models/Order.js';
import { logActivity, rupees } from './orderActivity.js';
import { pendingExchangeRows } from './exchange.js';

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
 *
 * Round 16 splits it into steps so an exchange of SOME items can reuse them: `pickLines` (check), `creditPieces`
 * (sale → credit), `takeBackPieces` (stock back). A refund does all three at once; a return-first exchange does the
 * first two and the replacement carries the credit; a swap at the door credits at once and takes the pieces back when
 * the old item arrives.
 */

/** Only a delivered courier parcel — a counter sale is settled at the counter. */
export const assertPartlyReturnable = order => {
  if (order.status !== ORDER_STATUS.DELIVERED) {
    throw new ErrorResponse('Only a delivered order can have items sent back', 400);
  }
  if (order.exchangedFor) throw new ErrorResponse('This order has already been exchanged', 400);
  if (isCounterSale(order)) {
    throw new ErrorResponse('A counter sale is settled at the counter, not here', 400);
  }
  // One exchange at a time: a second one would mix its credit with the first's (the replacement carries every waiting row).
  if (pendingExchangeRows(order).length) {
    throw new ErrorResponse(
      'Finish the exchange already started on this order first — send its replacement, or pay the credit back',
      400
    );
  }
  if (order.awaitingReturn) {
    throw new ErrorResponse(
      'The old item from the last swap has not come back yet — mark it received first',
      400
    );
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
 * Resolve and check the lines picked from an order — `[{ line, quantity }]`, a line being an order item's id — before
 * anything is posted: a bad one must leave nothing half done. Returns `[{ item, quantity }]`.
 */
export const pickLines = (order, lines = []) => {
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
  return picked;
};

/** How many pieces the order has, and how many are already back. */
const piecesOf = order => ({
  total: order.items.reduce((s, i) => s + i.quantity, 0),
  back: (order.returnedItems ?? []).reduce((s, r) => s + r.quantity, 0)
});

/**
 * True when `picked` is every piece of an order nothing has gone back from — an exchange of that is the whole-order
 * flow (the order becomes Exchanged), not a partial one.
 */
export const coversWholeOrder = (order, picked) => {
  const { total, back } = piecesOf(order);
  return back === 0 && picked.reduce((s, p) => s + p.quantity, 0) >= total;
};

/** What these pieces sold for and cost, in paisa. */
export const valueOf = picked => ({
  amountPaisa: picked.reduce((s, p) => s + toPaisa(p.item.unitPrice) * p.quantity, 0),
  costPaisa: picked.reduce((s, p) => s + toPaisa(p.item.unitCost) * p.quantity, 0)
});

export const wordsOf = picked =>
  picked
    .map(
      ({ item, quantity }) =>
        `${quantity} × ${item.productName}${item.variantLabel && item.variantLabel !== 'Default' ? ` (${item.variantLabel})` : ''}`
    )
    .join(', ');

/**
 * Step one of any partial return: the pieces' sale becomes the customer's credit (Dr Sales / Cr Advances from
 * customers), a `transfer-in` row says so, and `returnedItems` records each piece. It does NOT touch stock — that is
 * `takeBackPieces`, which a refund or a return-first exchange does at once and a swap at the door does when the old item
 * arrives (`stockPending`). `forExchange` marks the rows as waiting for a replacement to carry their credit.
 * Returns the entry and what the pieces were worth, in paisa.
 */
export const creditPieces = async (
  order,
  picked,
  {
    userId,
    forExchange = false,
    stockPending = false,
    returnBy = 'customer',
    returnCourierName,
    reversalTrackingId,
    note
  }
) => {
  const { amountPaisa, costPaisa } = valueOf(picked);
  await ensureChart(order.business);
  const entry = await entryFor(order, {
    memo: 'Items sent back: sale becomes credit',
    debit: CODES.SALES,
    credit: CODES.CUSTOMER_ADVANCES,
    amountPaisa,
    userId
  });
  // The money the customer paid for those pieces is now theirs to get back (the order's refund due) — or, for an
  // exchange, what a replacement carries.
  order.customerMoney.push({
    kind: 'transfer-in',
    amountPaisa,
    accountName: forExchange ? 'items being exchanged' : 'items sent back',
    date: new Date(),
    entry: entry._id,
    by: userId
  });

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
      note,
      forExchange: forExchange || undefined,
      stockPending: stockPending || undefined
    });
  }
  order.returnedPieces = piecesOf(order).back;
  if (reversalTrackingId) order.reversalTrackingId = reversalTrackingId;
  order.updatedBy = userId;
  return { entry, amountPaisa, costPaisa };
};

/** Step two: the pieces are back on the shelf — stock returns and their cost comes off the sale's COGS. */
export const takeBackPieces = async (order, picked, userId) => {
  await releaseStock(
    picked.map(({ item, quantity }) => ({
      product: item.product,
      variantId: item.variantId,
      quantity
    }))
  );
  const { costPaisa } = valueOf(picked);
  if (costPaisa > 0) {
    await ensureChart(order.business);
    await entryFor(order, {
      memo: 'Items sent back: goods back in stock',
      debit: CODES.INVENTORY,
      credit: CODES.COGS,
      amountPaisa: costPaisa,
      userId
    });
  }
};

/**
 * Record some pieces coming back for a refund. `lines` is `[{ line, quantity }]`; everything is checked before
 * anything is posted. `keep` (rupees) is held back from the refund.
 */
export const partialReturn = async (order, body, userId) => {
  assertPartlyReturnable(order);
  const { lines = [], returnBy = 'customer', returnCourierName, reversalTrackingId, note } = body;

  const picked = pickLines(order, lines);
  // Every piece back is not "some" — the whole-order flows already do that, with their own rules.
  const { total, back } = piecesOf(order);
  const nowBack = picked.reduce((s, p) => s + p.quantity, 0);
  if (back + nowBack >= total) {
    throw new ErrorResponse(
      'That is every piece — use Refund return or Exchange for the whole order',
      400
    );
  }
  const { amountPaisa } = valueOf(picked);
  const keepPaisa = toPaisa(body.keep ?? 0);
  if (keepPaisa > amountPaisa) {
    throw new ErrorResponse('You can not keep back more than the returned items cost', 400);
  }

  await creditPieces(order, picked, {
    userId,
    returnBy,
    returnCourierName,
    reversalTrackingId,
    note
  });
  await takeBackPieces(order, picked, userId);
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

  logActivity(
    order,
    { id: userId },
    {
      kind: 'money',
      text: `Sent back: ${wordsOf(picked)} — ${rupees(fromPaisa(amountPaisa))} back to the customer`
    }
  );
  order.awaitingReturn = false;
};
