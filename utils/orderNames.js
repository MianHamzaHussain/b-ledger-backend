import Product from '../models/Product.js';
import Order from '../models/Order.js';
import { BEFORE_DISPATCH } from './constants.js';

/**
 * An order's item names are snapshots (a delivered order must keep the name it sold under), but until
 * an order is dispatched it should follow its product: renaming "Beige Mehfil" to "Garden of Grace"
 * must not leave the courier's slip, or a pending order, still saying the old name.
 *
 * Policy: names follow the product until dispatch, then are frozen.
 */
/** The product's current name per line, by line index — a line whose product is gone keeps its own. */
export const liveItemNames = async order => {
  const ids = [...new Set(order.items.map(i => String(i.product)))];
  const found = await Product.find({ _id: { $in: ids } })
    .select('name')
    .lean();
  const byId = new Map(found.map(p => [String(p._id), p.name]));
  return order.items.map(i => byId.get(String(i.product)) ?? i.productName);
};

/**
 * `$set` entries that bring an order's stored names up to the live ones — empty when nothing changed.
 * Returned as a fragment so the caller can fold it into the write it is already making.
 */
export const nameUpdates = (order, names) =>
  Object.fromEntries(
    order.items.flatMap((item, index) =>
      names[index] && names[index] !== item.productName
        ? [[`items.${index}.productName`, names[index]]]
        : []
    )
  );

/**
 * A product was renamed: every order that has not shipped follows it. Dispatched and later orders are
 * left exactly as they sold.
 */
export const renameOnOpenOrders = (productId, name) =>
  Order.updateMany(
    { 'items.product': productId, status: { $in: BEFORE_DISPATCH } },
    { $set: { 'items.$[line].productName': name } },
    { arrayFilters: [{ 'line.product': productId }], timestamps: false }
  );
