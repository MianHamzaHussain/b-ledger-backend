import Product from '../models/Product.js';
import ErrorResponse from './errorResponse.js';

/**
 * Move stock for order line items, atomically and safely.
 *
 * Overselling is prevented by a CONDITIONAL decrement: the update only matches
 * when the variant still has enough stock, so two orders racing for the last
 * unit — one wins, the other matches nothing and is rejected. A plain
 * read-check-write would let both through.
 *
 * An article that keeps selling when out of stock (`allowOversell`) is the one
 * deliberate exception, and only when the caller opts in with
 * `{ allowOversell: true }` — customer orders do, sale-or-return handovers do
 * not (you can not hand a reseller pieces you do not have). Its decrement is
 * unconditional, so stock goes below zero: the minus is what customers are
 * still owed, and the next arrival fills it first. Each such line gets
 * `item.oversold` — how many of its pieces were not on the shelf — set on the
 * item passed in, because the order stores it with the line.
 *
 * The database here is standalone (no transactions), so a multi-item reserve
 * that fails partway is unwound by hand: the lines already taken are released
 * before the error is thrown. Never a silent partial deduction.
 *
 * Items are `{ product, variantId, quantity, productName? }`.
 */
export const reserveStock = async (items, { allowOversell = false } = {}) => {
  const keepsSelling = allowOversell ? await oversellProducts(items) : new Set();
  const taken = [];

  for (const item of items) {
    item.oversold = 0;

    if (keepsSelling.has(String(item.product))) {
      const after = await Product.findOneAndUpdate(
        { _id: item.product, variants: { $elemMatch: { _id: item.variantId } } },
        { $inc: { 'variants.$.stock': -item.quantity, totalStock: -item.quantity } },
        // No positional projection: Mongo refuses it together with returning the new document.
        { returnDocument: 'after', projection: { variants: 1 } }
      ).lean();
      if (after) {
        const stockNow = after.variants.find(v => String(v._id) === String(item.variantId)).stock;
        item.oversold = Math.max(0, Math.min(item.quantity, -stockNow));
        taken.push(item);
        continue;
      }
    } else {
      // $elemMatch is essential: it forces BOTH the id and the stock-≥ condition
      // onto the SAME variant. Written as two separate `variants.x` conditions,
      // Mongo may satisfy them with different array elements — the id matches one
      // size while another size's stock passes the check — and the positional `$`
      // then decrements the wrong variant. That is the overselling bug.
      const result = await Product.updateOne(
        {
          _id: item.product,
          variants: { $elemMatch: { _id: item.variantId, stock: { $gte: item.quantity } } }
        },
        // Keep the denormalised `totalStock` in step atomically — it is what the
        // lean product list shows, and this $inc bypasses the save hook.
        { $inc: { 'variants.$.stock': -item.quantity, totalStock: -item.quantity } }
      );
      if (result.modifiedCount === 1) {
        taken.push(item);
        continue;
      }
    }

    // Roll back everything already reserved for this order, then fail.
    await releaseStock(taken);
    throw new ErrorResponse(
      allowOversell
        ? `Not enough stock for ${item.productName || 'an item'} — turn on "Keep selling when out of stock" on the article to take the order anyway`
        : `Not enough stock for ${item.productName || 'an item'}`,
      400
    );
  }
};

/** The ids (as strings) of these items' products that keep selling when out of stock. */
const oversellProducts = async items => {
  const products = await Product.find(
    { _id: { $in: items.map(i => i.product) }, allowOversell: true },
    '_id'
  ).lean();
  return new Set(products.map(p => String(p._id)));
};

/** Return stock to inventory — used on cancel/return, and to unwind a failed reserve. */
export const releaseStock = async items => {
  for (const item of items) {
    await Product.updateOne(
      { _id: item.product, 'variants._id': item.variantId },
      { $inc: { 'variants.$.stock': item.quantity, totalStock: item.quantity } }
    );
  }
};
