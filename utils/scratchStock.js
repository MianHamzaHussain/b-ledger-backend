import Product from '../models/Product.js';
import Order from '../models/Order.js';
import ErrorResponse from './errorResponse.js';
import { CODES, accountByCode, ensureChart } from './chartOfAccounts.js';
import { postEntry, reverseEntry } from './ledger.js';
import { JOURNAL_SOURCES } from './constants.js';
import { fromPaisa } from './money.js';
import { weightedAverageCost } from './inventory.js';

/**
 * A made-from-scratch piece whose order fell through (cancelled, refused, or
 * sent back for a refund) is still a finished piece — so it goes into stock as a
 * product of its own, not into a loss. The next customer can then order it.
 *
 * Its cost is what the order's custom work cost (material + karigar), moved out
 * of Custom work in progress — or, once delivered, back out of COGS. The product
 * is tagged `customized` so these pieces can be found together. A second piece
 * given the same name joins the first as more stock of it.
 */

const VARIANT_LABEL = 'Made to measure';

/** The order's made-from-scratch lines. */
export const scratchLines = order => (order.customWork || []).filter(w => w.fromScratch);

/**
 * Split the order's custom cost across its made-from-scratch pieces by price —
 * the last takes the remainder so nothing is lost to rounding.
 */
const splitCost = (lines, totalPaisa) => {
  const totalPrice = lines.reduce((s, w) => s + Math.max(0, w.price), 0);
  let left = totalPaisa;
  return lines.map((w, i) => {
    if (i === lines.length - 1) return left;
    const share = totalPrice > 0 ? Math.round((totalPaisa * Math.max(0, w.price)) / totalPrice) : 0;
    left -= share;
    return share;
  });
};

const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Put the order's made-from-scratch pieces into stock. `pieces` names each one
 * and sets its price (by custom-work id); unnamed ones use the work's own text
 * and price. `fromCogs` — the order was delivered, so its cost already sits in
 * COGS rather than Custom work in progress.
 */
export const putScratchInStock = async (order, pieces = [], userId, { fromCogs = false } = {}) => {
  const lines = scratchLines(order);
  if (!lines.length) return false;

  await ensureChart(order.business);
  const totalCostPaisa = (order.customCosts || []).reduce((s, c) => s + c.amountPaisa, 0);
  const costs = splitCost(lines, totalCostPaisa);
  const byWork = new Map(pieces.map(p => [String(p.workId), p]));
  const results = [];

  for (const [i, work] of lines.entries()) {
    const given = byWork.get(String(work._id)) || {};
    const name = String(given.name || work.description)
      .trim()
      .slice(0, 120);
    const salePrice = given.salePrice != null ? Number(given.salePrice) : Math.max(0, work.price);
    const costPaisa = costs[i];

    let product = await Product.findOne({
      business: order.business,
      customized: true,
      name: { $regex: `^${escapeRegex(name)}$`, $options: 'i' }
    });
    let created = false;
    if (product) {
      const variant = product.variants[0];
      variant.costPrice = weightedAverageCost(
        variant.stock,
        variant.costPrice,
        1,
        fromPaisa(costPaisa)
      );
      variant.stock += 1;
      variant.salePrice = salePrice;
      product.updatedBy = userId;
    } else {
      product = new Product({
        business: order.business,
        name,
        customized: true,
        fromOrder: order._id,
        variants: [{ label: VARIANT_LABEL, costPrice: fromPaisa(costPaisa), salePrice, stock: 1 }],
        createdBy: userId
      });
      created = true;
    }
    await product.save();
    results.push({
      product: product._id,
      variantId: product.variants[0]._id,
      name,
      costPaisa,
      created
    });
  }

  let entry = null;
  if (totalCostPaisa > 0) {
    const label = `Order #${order.orderNumber} · made from scratch`;
    entry = await postEntry({
      business: order.business,
      memo: `Into stock — ${results.map(r => r.name).join(', ')} (${label})`,
      source: { kind: JOURNAL_SOURCES.ORDER, ref: String(order._id) },
      lines: [
        {
          account: (await accountByCode(order.business, CODES.INVENTORY))._id,
          label,
          debitPaisa: totalCostPaisa
        },
        {
          account: (await accountByCode(order.business, fromCogs ? CODES.COGS : CODES.CUSTOM_WIP))
            ._id,
          label,
          creditPaisa: totalCostPaisa
        }
      ],
      userId
    });
  }
  order.scratchStock = results.map(r => ({ ...r, entry: entry?._id }));
  return true;
};

/**
 * Reopening the order: take its pieces back out of stock and undo the entry.
 * Refused if a piece has been sold since — it's no longer ours to put back.
 * A product this order created, left empty and never ordered, is removed.
 */
export const takeScratchBack = async (order, userId) => {
  const rows = order.scratchStock || [];
  if (!rows.length) return;

  const taken = [];
  for (const row of rows) {
    const result = await Product.updateOne(
      { _id: row.product, variants: { $elemMatch: { _id: row.variantId, stock: { $gte: 1 } } } },
      { $inc: { 'variants.$.stock': -1, totalStock: -1 } }
    );
    if (result.modifiedCount !== 1) {
      for (const t of taken) {
        await Product.updateOne(
          { _id: t.product, 'variants._id': t.variantId },
          { $inc: { 'variants.$.stock': 1, totalStock: 1 } }
        );
      }
      throw new ErrorResponse(
        `"${row.name}" has been sold since — this order can't be reopened`,
        400
      );
    }
    taken.push(row);
  }

  const entryId = rows.find(r => r.entry)?.entry;
  if (entryId) {
    await reverseEntry(entryId, { userId, memo: `Reopen — order ${order.orderNumber}` });
  }
  for (const row of rows) {
    if (!row.created) continue;
    const product = await Product.findById(row.product);
    const sold = await Order.exists({ 'items.product': row.product });
    if (product && product.totalStock <= 0 && !sold) await product.deleteOne();
  }
  order.scratchStock = [];
};

/** The cost of this order's custom work, in rupees — for a piece's cost preview. */
export const customCostOf = order =>
  fromPaisa((order.customCosts || []).reduce((s, c) => s + c.amountPaisa, 0));
