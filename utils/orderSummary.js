import mongoose from 'mongoose';
import Order from '../models/Order.js';
import { pakistanDay, startOfPakistanDay, endOfPakistanDay } from './pakistanDay.js';

/**
 * The small "how is today going" numbers on the Orders screen, in one round trip.
 *
 * "Today" is the Pakistan day, worked out here so a phone with the wrong clock or zone can not
 * skew it. Dispatched / delivered count the day the event happened (an order sent and delivered
 * today counts in both); `byStatus` is every order's CURRENT status across all dates, so old
 * forgotten pending orders can not hide.
 */
export const orderSummary = async (business, now = new Date()) => {
  const day = pakistanDay(now);
  const today = { $gte: startOfPakistanDay(day), $lte: endOfPakistanDay(day) };
  const scope = { business: new mongoose.Types.ObjectId(String(business)) };

  const [createdToday, dispatchedToday, deliveredToday, dueNow, courierReady, grouped] =
    await Promise.all([
      Order.countDocuments({ ...scope, createdAt: today }),
      Order.countDocuments({ ...scope, dispatchedAt: today }),
      Order.countDocuments({ ...scope, deliveredAt: today }),
      // Booked orders whose day has come (or gone) — what the daily alert is about.
      Order.countDocuments({ ...scope, status: 'booked', bookedFor: { $lte: day } }),
      // Parcels the courier says are delivered / returned, waiting for one tap to confirm.
      Order.countDocuments({
        ...scope,
        status: 'dispatched',
        'courierBooking.confirmable': { $exists: true }
      }),
      Order.aggregate([{ $match: scope }, { $group: { _id: '$status', count: { $sum: 1 } } }])
    ]);

  const byStatus = Object.fromEntries(grouped.map(g => [g._id, g.count]));
  return {
    createdToday,
    dispatchedToday,
    deliveredToday,
    dueNow,
    courierReady,
    pending: byStatus.pending ?? 0,
    byStatus
  };
};
