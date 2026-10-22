import GoodsReceipt from '../models/GoodsReceipt.js';
import Product from '../models/Product.js';
import ErrorResponse from './errorResponse.js';
import { accountByCode, CODES, ensureChart } from './chartOfAccounts.js';
import { postEntry, reverseEntry } from './ledger.js';
import { weightedAverageCost } from './inventory.js';
import { fromPaisa, toPaisa } from './money.js';
import { JOURNAL_SOURCES } from './constants.js';

/**
 * Finished goods bought from a supplier — the one place stock, cost and the
 * books move for a delivery, a send-back, and the undo of a delivery.
 *
 *   arrive     Dr Inventory / Cr Payables [supplier]              the bill
 *              Dr Payables [supplier] / Cr money   (if paid now)  the payment
 *   send back  Dr Payables [supplier] / Cr Inventory              at the RECEIPT's cost
 *
 * A send-back credits what the supplier billed, not today's average, and removes
 * exactly that value from the article's stock before re-averaging the rest — so
 * the Inventory account and the stock never drift apart.
 */

const source = receipt => ({ kind: JOURNAL_SOURCES.GOODS_RECEIPT, ref: String(receipt._id) });

/**
 * Change one size's stock and cost atomically. `change(variant)` returns the
 * signed `{ qty, costPrice }` to apply, computed from the CURRENT row; the write
 * only lands if stock and cost are still what was read (two receipts, or a sale
 * racing a send-back, can't both act on the same last piece). A lost race re-reads.
 * `totalStock` is kept in step here because this write bypasses the save hook.
 *
 * Resolves `{ before, after }` for that size.
 */
const changeVariant = async (productId, variantId, change) => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const product = await Product.findOne(
      { _id: productId, 'variants._id': variantId },
      { 'variants.$': 1 }
    ).lean();
    const before = product?.variants?.[0];
    if (!before) throw new ErrorResponse('That article or size is no longer there', 404);

    const { qty, costPrice } = change(before);
    const result = await Product.updateOne(
      {
        _id: productId,
        variants: {
          $elemMatch: { _id: variantId, stock: before.stock, costPrice: before.costPrice }
        }
      },
      {
        $set: { 'variants.$.costPrice': costPrice },
        $inc: { 'variants.$.stock': qty, totalStock: qty }
      }
    );
    if (result.modifiedCount === 1) {
      return { before, after: { stock: before.stock + qty, costPrice } };
    }
  }
  throw new ErrorResponse('That size is being changed right now — try again', 409);
};

/** Pieces arrive at `unitCostPaisa` — the average cost moves with them. */
const putIn = (qty, unitCostPaisa) => variant => ({
  qty,
  costPrice: weightedAverageCost(variant.stock, variant.costPrice, qty, fromPaisa(unitCostPaisa))
});

/**
 * Pieces leave, taking exactly `valuePaisa` of stock value with them; whatever is
 * left is re-averaged over what remains, and nothing remaining means no cost.
 */
const takeOut = (qty, valuePaisa, name) => variant => {
  if (variant.stock < qty) {
    throw new ErrorResponse(`Only ${variant.stock} of ${name} left to send back`, 400);
  }
  const remaining = variant.stock - qty;
  const left = Math.max(0, toPaisa(variant.costPrice) * variant.stock - valuePaisa);
  return { qty: -qty, costPrice: remaining > 0 ? fromPaisa(Math.round(left / remaining)) : 0 };
};

const lineName = line => `${line.productName} (${line.variantLabel})`;

/** Resolve one "existing article" line against this business, and snapshot it. */
const resolveExistingLine = async (business, raw) => {
  const product = await Product.findOne({ _id: raw.product, business });
  const variant = product?.variants.id(raw.variantId);
  if (!product || !variant) {
    throw new ErrorResponse('That article or size is not in this business', 400);
  }
  return {
    product: product._id,
    variantId: variant._id,
    productName: product.name,
    variantLabel: variant.label,
    articleNumber: product.articleNumber,
    quantity: raw.quantity,
    unitCostPaisa: raw.unitCostPaisa,
    createdProduct: false
  };
};

/**
 * Bring goods in. `rawLines` are `{ product, variantId, quantity, unitCostPaisa }`
 * for an article we already have, or `{ newProduct: { name, variants: [{ label,
 * salePrice, quantity, unitCostPaisa }] } }` for one this delivery creates.
 *
 * The entry posts first, so a locked period refuses before any stock moves; if
 * stock then fails, the entry is reversed and every change is undone — never a
 * delivery that is in the books but not on the shelf, or the other way round.
 */
export const receiveGoods = async ({
  business,
  supplier,
  date,
  note,
  rawLines,
  paidNowPaisa = 0,
  money,
  userId
}) => {
  await ensureChart(business);

  // ── Build the lines (validates every one before anything is written) ──────
  const lines = [];
  const newArticles = []; // { product doc, built lines } created at apply time
  for (const raw of rawLines) {
    if (raw.newProduct) {
      const built = raw.newProduct.variants.map(v => ({
        variantLabel: v.label,
        salePrice: v.salePrice,
        quantity: v.quantity,
        unitCostPaisa: v.unitCostPaisa
      }));
      newArticles.push({ name: raw.newProduct.name, built });
    } else {
      lines.push(await resolveExistingLine(business, raw));
    }
  }

  const totalOf = list => list.reduce((sum, l) => sum + l.quantity * l.unitCostPaisa, 0);
  const totalCostPaisa = totalOf(lines) + newArticles.reduce((sum, a) => sum + totalOf(a.built), 0);
  const pieces =
    lines.reduce((n, l) => n + l.quantity, 0) +
    newArticles.reduce((n, a) => n + a.built.reduce((m, v) => m + v.quantity, 0), 0);

  if (paidNowPaisa > totalCostPaisa) {
    throw new ErrorResponse('You can not pay more now than the goods cost', 400);
  }

  const receipt = new GoodsReceipt({
    business,
    party: supplier._id,
    date: date || undefined,
    note,
    totalCostPaisa,
    paidNowPaisa,
    paidFrom: paidNowPaisa > 0 ? money.name : undefined,
    createdBy: userId
  });

  // ── The books first ──────────────────────────────────────────────────────
  const payable = (await accountByCode(business, CODES.ACCOUNTS_PAYABLE))._id;
  const what = `Goods from ${supplier.name} · ${pieces} piece${pieces === 1 ? '' : 's'}`;
  const entry = await postEntry({
    business,
    date,
    memo: what,
    source: source(receipt),
    lines: [
      {
        account: (await accountByCode(business, CODES.INVENTORY))._id,
        label: what,
        debitPaisa: totalCostPaisa
      },
      {
        account: payable,
        party: supplier._id,
        label: `Bill — ${what}`,
        creditPaisa: totalCostPaisa
      },
      ...(paidNowPaisa > 0
        ? [
            {
              account: payable,
              party: supplier._id,
              label: `Paid — ${what}`,
              debitPaisa: paidNowPaisa
            },
            { account: money.account, label: what, creditPaisa: paidNowPaisa }
          ]
        : [])
    ],
    userId
  });

  // ── Then the shelf, undoing everything if any step fails ─────────────────
  const applied = []; // existing sizes whose stock went up
  const created = []; // articles this delivery made
  try {
    for (const line of lines) {
      const { before } = await changeVariant(
        line.product,
        line.variantId,
        putIn(line.quantity, line.unitCostPaisa)
      );
      applied.push({ line, before });
    }

    for (const article of newArticles) {
      const product = await Product.create({
        business,
        name: article.name,
        createdBy: userId,
        variants: article.built.map(v => ({
          label: v.variantLabel,
          salePrice: v.salePrice,
          costPrice: fromPaisa(v.unitCostPaisa),
          stock: v.quantity
        }))
      });
      created.push(product._id);
      product.variants.forEach((variant, i) => {
        const v = article.built[i];
        lines.push({
          product: product._id,
          variantId: variant._id,
          productName: product.name,
          variantLabel: variant.label,
          articleNumber: product.articleNumber,
          quantity: v.quantity,
          unitCostPaisa: v.unitCostPaisa,
          createdProduct: true
        });
      });
    }

    receipt.lines = lines;
    receipt.receiveEntry = entry._id;
    receipt.date = entry.date;
    await receipt.save();
  } catch (err) {
    for (const { line, before } of applied) {
      await Product.updateOne(
        { _id: line.product, 'variants._id': line.variantId },
        {
          $set: { 'variants.$.costPrice': before.costPrice },
          $inc: { 'variants.$.stock': -line.quantity, totalStock: -line.quantity }
        }
      );
    }
    if (created.length) await Product.deleteMany({ _id: { $in: created } });
    await reverseEntry(entry._id, { userId, memo: `Undo — ${what}` });
    throw err;
  }

  return receipt;
};

/** What is still free to go back on one line: what arrived, less what went, and only what is on the shelf. */
export const returnableOf = (line, stock) =>
  Math.max(0, Math.min(line.quantity - line.quantityReturned, stock));

/**
 * Send pieces back to the supplier. `items` are `{ lineId, quantity }`. Credits
 * the supplier at each line's own unit cost.
 */
export const returnToSupplier = async ({ receipt, items, date, note, userId }) => {
  if (receipt.status !== 'received') {
    throw new ErrorResponse('This delivery was undone — there is nothing to send back', 400);
  }

  // Validate every line before anything moves.
  const plan = [];
  for (const item of items) {
    const line = receipt.lines.id(item.lineId);
    if (!line) throw new ErrorResponse('That line is not on this delivery', 400);
    const left = line.quantity - line.quantityReturned;
    if (item.quantity > left) {
      throw new ErrorResponse(`Only ${left} of ${lineName(line)} left to send back`, 400);
    }
    plan.push({ line, quantity: item.quantity, valuePaisa: item.quantity * line.unitCostPaisa });
  }
  const valuePaisa = plan.reduce((sum, p) => sum + p.valuePaisa, 0);

  // Look at the shelf before posting anything: asking for more than is there is the
  // common mistake, and it should leave no trace in the supplier's Khata. (A race
  // that slips past this is still caught, and undone, when the stock is taken.)
  for (const { line, quantity } of plan) {
    const product = await Product.findOne(
      { _id: line.product, 'variants._id': line.variantId },
      { 'variants.$': 1 }
    ).lean();
    const stock = product?.variants?.[0]?.stock ?? 0;
    if (stock < quantity) {
      throw new ErrorResponse(`Only ${stock} of ${lineName(line)} left to send back`, 400);
    }
  }

  const supplier = receipt.party;
  const payable = (await accountByCode(receipt.business, CODES.ACCOUNTS_PAYABLE))._id;
  const what = `Sent back to supplier · delivery #${receipt.receiptNumber}`;
  const entry = await postEntry({
    business: receipt.business,
    date,
    memo: what,
    source: source(receipt),
    lines: [
      { account: payable, party: supplier, label: what, debitPaisa: valuePaisa },
      {
        account: (await accountByCode(receipt.business, CODES.INVENTORY))._id,
        label: what,
        creditPaisa: valuePaisa
      }
    ],
    userId
  });

  const applied = [];
  try {
    for (const { line, quantity, valuePaisa: value } of plan) {
      const { before } = await changeVariant(
        line.product,
        line.variantId,
        takeOut(quantity, value, lineName(line))
      );
      applied.push({ line, quantity, before });
    }
  } catch (err) {
    for (const { line, quantity, before } of applied) {
      await Product.updateOne(
        { _id: line.product, 'variants._id': line.variantId },
        {
          $set: { 'variants.$.costPrice': before.costPrice },
          $inc: { 'variants.$.stock': quantity, totalStock: quantity }
        }
      );
    }
    await reverseEntry(entry._id, { userId, memo: `Undo — ${what}` });
    throw err;
  }

  for (const { line, quantity } of plan) line.quantityReturned += quantity;
  receipt.returns.push({
    date: entry.date,
    note,
    lines: plan.map(p => ({ lineId: p.line._id, quantity: p.quantity })),
    valuePaisa,
    entry: entry._id,
    by: userId
  });
  receipt.updatedBy = userId;
  try {
    // The receipt checks its version on save, so a send-back that raced this one
    // fails here instead of both counting the same pieces.
    await receipt.save();
  } catch (err) {
    for (const { line, quantity, before } of applied) {
      await Product.updateOne(
        { _id: line.product, 'variants._id': line.variantId },
        {
          $set: { 'variants.$.costPrice': before.costPrice },
          $inc: { 'variants.$.stock': quantity, totalStock: quantity }
        }
      );
    }
    await reverseEntry(entry._id, { userId, memo: `Undo — ${what}` });
    throw err;
  }
  return receipt;
};

const restoreTaken = async taken => {
  for (const { line, before } of taken) {
    await Product.updateOne(
      { _id: line.product, 'variants._id': line.variantId },
      {
        $set: { 'variants.$.costPrice': before.costPrice },
        $inc: { 'variants.$.stock': line.quantity, totalStock: line.quantity }
      }
    );
  }
};

/**
 * Undo a delivery that is still untouched: nothing sent back, and every size
 * still holds what arrived (nothing sold). Reverses the books and takes the
 * stock back. An article this delivery created stays, at zero stock.
 */
export const undoReceipt = async ({ receipt, userId }) => {
  if (receipt.status !== 'received') {
    throw new ErrorResponse('This delivery was already undone', 400);
  }
  if (receipt.returns.length > 0) {
    throw new ErrorResponse('Some of this was already sent back, so it can not be undone', 400);
  }

  // Claim it first: only one undo can flip received → reversed, so two clicks (or
  // two people) can't both take the stock back.
  const claimed = await GoodsReceipt.updateOne(
    { _id: receipt._id, status: 'received', 'returns.0': { $exists: false } },
    // __v moves too, so a send-back that loaded the receipt before this fails its save.
    { $set: { status: 'reversed', updatedBy: userId }, $inc: { __v: 1 } }
  );
  if (claimed.modifiedCount !== 1) {
    throw new ErrorResponse('This delivery changed — reload it and try again', 409);
  }
  const release = () =>
    GoodsReceipt.updateOne(
      { _id: receipt._id },
      { $set: { status: 'received' }, $inc: { __v: 1 } }
    );

  // Stock next: it is atomic and refuses if any of it has been sold. The books
  // are reversed after, because a locked period can refuse that — and then the
  // stock goes back.
  const taken = [];
  try {
    for (const line of receipt.lines) {
      const { before } = await changeVariant(
        line.product,
        line.variantId,
        takeOut(line.quantity, line.quantity * line.unitCostPaisa, lineName(line))
      );
      taken.push({ line, before });
    }
  } catch (err) {
    await restoreTaken(taken);
    await release();
    if (err instanceof ErrorResponse && err.statusCode === 400) {
      throw new ErrorResponse('Some of these are already sold — send the rest back instead', 400);
    }
    throw err;
  }

  try {
    await reverseEntry(receipt.receiveEntry, {
      userId,
      memo: `Undo goods received #${receipt.receiptNumber}`
    });
  } catch (err) {
    await restoreTaken(taken);
    await release();
    throw err;
  }

  receipt.status = 'reversed';
  receipt.updatedBy = userId;
  return receipt;
};
