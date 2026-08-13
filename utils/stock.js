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
 * The database here is standalone (no transactions), so a multi-item reserve
 * that fails partway is unwound by hand: the lines already taken are released
 * before the error is thrown. Never a silent partial deduction.
 *
 * Items are `{ product, variantId, quantity, productName? }`.
 */
export const reserveStock = async items => {
  const taken = [];

  for (const item of items) {
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
    } else {
      // Roll back everything already reserved for this order, then fail.
      await releaseStock(taken);
      throw new ErrorResponse(`Not enough stock for ${item.productName || 'an item'}`, 400);
    }
  }
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
