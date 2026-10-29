import mongoose from 'mongoose';
import Order from '../models/Order.js';
import { ORDER_STATUS } from './constants.js';

/**
 * What a customer's orders add up to, for the order form's "New / Repeat" line and the customer page.
 * Computed on demand for the few customers asked about (one aggregation, on the
 * `{ business, customer, createdAt }` index) — never stored, because a stored counter drifts the first
 * time an order changes status.
 *
 * "Delivered" counts an order that reached the customer even if it was later exchanged or refunded;
 * "returned" is a parcel the customer refused.
 */
const DELIVERED_ONCE = [ORDER_STATUS.DELIVERED, ORDER_STATUS.EXCHANGED, ORDER_STATUS.REFUNDED];

const oid = id => new mongoose.Types.ObjectId(String(id));
const countWhen = cond => ({ $sum: { $cond: [cond, 1, 0] } });

export const customerStats = async (business, customerIds) => {
  const stats = new Map();
  if (!customerIds.length) return stats;

  const rows = await Order.aggregate([
    { $match: { business: oid(business), customer: { $in: customerIds.map(oid) } } },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: '$customer',
        orders: { $sum: 1 },
        delivered: countWhen({ $in: ['$status', DELIVERED_ONCE] }),
        returned: countWhen({ $eq: ['$status', ORDER_STATUS.RETURNED] }),
        cancelled: countWhen({ $eq: ['$status', ORDER_STATUS.CANCELLED] }),
        refusedTries: {
          $sum: {
            $size: {
              $filter: {
                input: { $ifNull: ['$deliveryAttempts', []] },
                as: 'a',
                cond: { $eq: ['$$a.reason', 'refused'] }
              }
            }
          }
        },
        boughtAmount: {
          $sum: { $cond: [{ $in: ['$status', DELIVERED_ONCE] }, '$total', 0] }
        },
        firstOrderAt: { $min: '$createdAt' },
        lastOrderAt: { $max: '$createdAt' },
        // The newest order's address (the sort above is newest first).
        lastAddress: { $first: '$deliveryAddress' }
      }
    }
  ]);

  for (const { _id, ...rest } of rows) stats.set(String(_id), rest);
  return stats;
};

/** The numbers for a customer with no orders yet. */
export const NO_ORDERS = {
  orders: 0,
  delivered: 0,
  returned: 0,
  cancelled: 0,
  refusedTries: 0,
  boughtAmount: 0
};
