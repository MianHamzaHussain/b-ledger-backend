import mongoose from 'mongoose';
import Order from '../models/Order.js';
import { ORDER_STATUS } from './constants.js';

/**
 * Courier performance: per courier and/or city, how many parcels went out and
 * what became of them. The measure is parcels DISPATCHED in the range, so every
 * ratio compares like with like.
 *
 * Who is to blame is kept honest on purpose:
 *  - Delivered % and Returned % use only the parcels the courier finished
 *    (delivered + returned). Refunded and exchanged parcels WERE delivered — the
 *    customer sent them back afterwards, usually their own decision — so they
 *    count as delivered and are shown apart, never against the courier.
 *  - A cancelled order never has a courier (cancelling is only possible before
 *    dispatch), so it cannot sit in a courier row; it is one number for the
 *    period.
 */

/** Under this many decided parcels a ratio is noise, and the UI says so. */
export const MIN_DECIDED = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

// Pakistan has no daylight saving (UTC+5 all year), so a Pakistan day is a fixed
// 24-hour window. `to` is exclusive: the start of the day after the last day.
const startOfDay = day => new Date(`${day}T00:00:00+05:00`);
const startOfNextDay = day => new Date(startOfDay(day).getTime() + DAY_MS);

const DELIVERED_STATUSES = [ORDER_STATUS.DELIVERED, ORDER_STATUS.REFUNDED, ORDER_STATUS.EXCHANGED];

const is = status => ({ $cond: [{ $eq: ['$status', status] }, 1, 0] });
const isDelivered = { $in: ['$status', DELIVERED_STATUSES] };

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
const round1 = value => Math.round(value * 10) / 10;

/** A row's visible figures from its raw sums — shared by the rows and the totals. */
const present = raw => {
  const decided = raw.delivered + raw.returned;
  return {
    dispatched: raw.dispatched,
    delivered: raw.delivered,
    refunded: raw.refunded,
    exchanged: raw.exchanged,
    returned: raw.returned,
    inTransit: raw.inTransit,
    decided,
    deliveredPct: pct(raw.delivered, decided),
    returnedPct: pct(raw.returned, decided),
    // Informational only — the customer's decision, never used to rank a courier.
    sentBackByCustomerPct: pct(raw.refunded + raw.exchanged, raw.delivered),
    avgDaysToDeliver: raw.daysCount > 0 ? round1(raw.daysSum / raw.daysCount) : null,
    firstAttemptPct: pct(raw.firstTry, raw.tracked),
    firstAttemptBasis: raw.tracked
  };
};

/**
 * @param {string} business
 * @param {{ from: string, to: string, by: 'courier'|'city'|'courier-city' }} options
 *        `from`/`to` are Pakistan days (YYYY-MM-DD), inclusive.
 */
export const courierPerformance = async (business, { from, to, by }) => {
  const businessId = new mongoose.Types.ObjectId(business);
  const range = { $gte: startOfDay(from), $lt: startOfNextDay(to) };

  const groupKey = {};
  if (by !== 'city') groupKey.courier = '$courier';
  if (by !== 'courier') groupKey.city = { $ifNull: ['$city', 'Unknown'] };

  const grouped = await Order.aggregate([
    // A counter sale has no courier, so it never enters this report.
    { $match: { business: businessId, courier: { $ne: null }, dispatchedAt: range } },
    {
      $group: {
        _id: groupKey,
        dispatched: { $sum: 1 },
        delivered: { $sum: { $cond: [isDelivered, 1, 0] } },
        refunded: { $sum: is(ORDER_STATUS.REFUNDED) },
        exchanged: { $sum: is(ORDER_STATUS.EXCHANGED) },
        returned: { $sum: is(ORDER_STATUS.RETURNED) },
        inTransit: { $sum: is(ORDER_STATUS.DISPATCHED) },
        // Days to deliver — only parcels that really carry both dates.
        daysSum: {
          $sum: {
            $cond: [
              { $and: [isDelivered, { $ne: [{ $type: '$deliveredAt' }, 'missing'] }] },
              {
                $max: [0, { $divide: [{ $subtract: ['$deliveredAt', '$dispatchedAt'] }, DAY_MS] }]
              },
              0
            ]
          }
        },
        daysCount: {
          $sum: {
            $cond: [{ $and: [isDelivered, { $ne: [{ $type: '$deliveredAt' }, 'missing'] }] }, 1, 0]
          }
        },
        // First attempt: only parcels sent after attempts could be logged.
        tracked: {
          $sum: { $cond: [{ $and: [isDelivered, { $eq: ['$attemptsTracked', true] }] }, 1, 0] }
        },
        firstTry: {
          $sum: {
            $cond: [
              {
                $and: [
                  isDelivered,
                  { $eq: ['$attemptsTracked', true] },
                  { $eq: [{ $size: { $ifNull: ['$deliveryAttempts', []] } }, 0] }
                ]
              },
              1,
              0
            ]
          }
        }
      }
    },
    {
      $lookup: {
        from: 'parties',
        localField: '_id.courier',
        foreignField: '_id',
        as: 'courierParty'
      }
    }
  ]);

  const rows = grouped
    .map(row => ({
      ...(row._id.courier && {
        courierId: String(row._id.courier),
        courier: row.courierParty[0]?.name || 'Unknown courier'
      }),
      ...(row._id.city && { city: row._id.city }),
      ...present(row),
      tooFew: row.delivered + row.returned < MIN_DECIDED
    }))
    .sort(
      (a, b) =>
        b.delivered - a.delivered ||
        (a.courier || '').localeCompare(b.courier || '') ||
        (a.city || '').localeCompare(b.city || '')
    );

  // Totals come from the raw sums, so an average is weighted, never an average of averages.
  const sum = key => grouped.reduce((total, row) => total + row[key], 0);
  const totals = present({
    dispatched: sum('dispatched'),
    delivered: sum('delivered'),
    refunded: sum('refunded'),
    exchanged: sum('exchanged'),
    returned: sum('returned'),
    inTransit: sum('inTransit'),
    daysSum: sum('daysSum'),
    daysCount: sum('daysCount'),
    tracked: sum('tracked'),
    firstTry: sum('firstTry')
  });

  // Cancelled orders have no courier, so they cannot appear above: one number.
  const cancelledBeforeDispatch = await Order.countDocuments({
    business: businessId,
    status: ORDER_STATUS.CANCELLED,
    cancelledAt: range
  });

  return {
    from,
    to,
    by,
    minDecided: MIN_DECIDED,
    cancelledBeforeDispatch,
    totals,
    rows,
    selfDelivery: await selfDeliveryRows(businessId, range)
  };
};

/**
 * Parcels we took ourselves, per person: how many went out, what became of them, what the trips
 * cost and what cash came back. Money is paisa. No ratios against couriers — a person is not a
 * courier, and the cost per parcel is the figure worth comparing.
 */
const selfDeliveryRows = async (businessId, range) => {
  const grouped = await Order.aggregate([
    { $match: { business: businessId, selfDelivery: true, dispatchedAt: range } },
    {
      $group: {
        _id: { $ifNull: ['$deliveredBy', 'Unknown'] },
        dispatched: { $sum: 1 },
        delivered: { $sum: { $cond: [isDelivered, 1, 0] } },
        returned: { $sum: is(ORDER_STATUS.RETURNED) },
        inTransit: { $sum: is(ORDER_STATUS.DISPATCHED) },
        costPaisa: {
          $sum: {
            $add: [{ $ifNull: ['$deliveryChargePaisa', 0] }, { $ifNull: ['$returnChargePaisa', 0] }]
          }
        },
        collectedPaisa: {
          $sum: {
            $cond: [{ $ne: ['$selfCollectAccount', null] }, { $ifNull: ['$paidPaisa', 0] }, 0]
          }
        }
      }
    }
  ]);

  const rows = grouped
    .map(g => ({
      person: g._id,
      dispatched: g.dispatched,
      delivered: g.delivered,
      returned: g.returned,
      inTransit: g.inTransit,
      costPaisa: g.costPaisa,
      costPerParcelPaisa: g.dispatched > 0 ? Math.round(g.costPaisa / g.dispatched) : 0,
      collectedPaisa: g.collectedPaisa
    }))
    .sort((a, b) => b.dispatched - a.dispatched || a.person.localeCompare(b.person));

  const sum = key => rows.reduce((total, r) => total + r[key], 0);
  const dispatched = sum('dispatched');
  return {
    rows,
    totals: {
      dispatched,
      delivered: sum('delivered'),
      returned: sum('returned'),
      inTransit: sum('inTransit'),
      costPaisa: sum('costPaisa'),
      costPerParcelPaisa: dispatched > 0 ? Math.round(sum('costPaisa') / dispatched) : 0,
      collectedPaisa: sum('collectedPaisa')
    }
  };
};
