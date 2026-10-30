import Order from '../../models/Order.js';
import logger from '../logger.js';
import { normalizePhone } from '../phone.js';
import { ORDER_STATUS } from '../constants.js';
import { adapterFor } from './index.js';

/**
 * Take over a tracking number a person typed in by hand.
 *
 * Staff often book on the courier's own site and paste the number into the order. To the app that is a text
 * box, so the status check never followed it. This finds those dispatched orders, asks the courier about each
 * number, and — only when it is clearly the same parcel — gives the order the same booking record an in-app
 * booking leaves, so the normal 10-minute check follows it from there (stage, journey, alerts, automatic
 * delivered/returned).
 *
 * Why it is strict: a wrong match would mark the wrong order delivered and post its sale and stock. So the
 * number must be the courier's, on no other order, typed on only one order, with the same amount and (when
 * the courier sends one) the same phone. Anything else is left alone, with the reason kept on the order.
 * A number that was not taken over is tried again at most once an hour.
 */
const RETRY_MS = 60 * 60 * 1000;
const BATCH = 20;
const PER_RUN = 300;
const ADOPTABLE = new Set(['postex']);

const sameMoney = (a, b) => Math.abs(Number(a) - Number(b)) <= 1;

/** Every number on the order ("0311 0007954 / 0333 2294985"), normalised. */
const phonesOf = order =>
  String(order.contactNumber ?? '')
    .split(/[/,;]|\s{2,}/)
    .map(p => normalizePhone(p))
    .filter(Boolean);

/**
 * Is this courier parcel clearly this order's? `parcel` is what the courier answered (null when it does not
 * know the number); `others` is how many other orders already carry the number, and `typedOn` how many
 * dispatched orders were typed with it. Returns `{ ok: true }` or `{ ok: false, reason }` in plain words.
 */
export const judgeParcel = (order, parcel, { others = 0, typedOn = 1 } = {}) => {
  if (!parcel?.trackingNumber)
    return { ok: false, reason: 'The courier does not know this tracking number' };
  if (others > 0) return { ok: false, reason: 'This parcel is already attached to another order' };
  if (typedOn > 1)
    return { ok: false, reason: 'The same tracking number is typed on more than one order' };
  if (
    !sameMoney(parcel.invoicePayment, order.codAmount) &&
    !sameMoney(parcel.invoicePayment, order.total)
  ) {
    return {
      ok: false,
      reason: `The courier's amount (Rs ${parcel.invoicePayment}) is not this order's (Rs ${order.codAmount})`
    };
  }
  const theirs = normalizePhone(parcel.customerPhone);
  if (theirs && !phonesOf(order).includes(theirs)) {
    return { ok: false, reason: 'The courier has a different phone number for this parcel' };
  }
  return { ok: true };
};

/** Dispatched orders with a typed-in number and no courier booking, not tried within the hour. */
export const typedOrders = ({ business = null, now = Date.now() } = {}) =>
  Order.find({
    status: ORDER_STATUS.DISPATCHED,
    courier: { $exists: true },
    trackingId: { $exists: true, $nin: ['', null] },
    'courierBooking.trackingNumber': { $exists: false },
    $or: [
      { 'adoptTry.at': { $exists: false } },
      { 'adoptTry.at': { $lt: new Date(now - RETRY_MS) } }
    ],
    ...(business ? { business } : {})
  })
    .sort({ 'adoptTry.at': 1 })
    .limit(PER_RUN);

/**
 * One pass: take over every typed number that is clearly the courier's parcel. Returns the tally.
 */
export const adoptTypedParcels = async ({ business = null } = {}) => {
  const tally = { checked: 0, adopted: 0, skipped: 0, errors: 0 };
  const orders = await typedOrders({ business });

  const byCourier = new Map();
  for (const o of orders) {
    const key = String(o.courier);
    if (!byCourier.has(key)) byCourier.set(key, []);
    byCourier.get(key).push(o);
  }

  for (const [courierId, list] of byCourier) {
    let api;
    let provider;
    try {
      let party;
      ({ api, provider, party } = await adapterFor(courierId, { requireEnabled: false }));
      if (party.integration?.adoptTyped === false) continue;
    } catch {
      continue; // not a connected courier: its typed numbers are for a person to follow
    }
    if (!ADOPTABLE.has(provider)) continue;

    const numberOf = o => o.trackingId.trim();
    const typed = new Map();
    for (const o of list) typed.set(numberOf(o), (typed.get(numberOf(o)) ?? 0) + 1);

    for (let i = 0; i < list.length; i += BATCH) {
      const group = list.slice(i, i + BATCH);
      const numbers = [...new Set(group.map(numberOf))];
      let rows;
      try {
        rows = await api.trackBulk(numbers);
      } catch (err) {
        // Not tried: a courier that could not be reached is not a reason to give up on a number for an hour.
        tally.errors += group.length;
        logger.warn({ err: err.message }, 'typed tracking numbers not checked');
        continue;
      }
      const parcels = new Map(rows.filter(r => r.found !== false).map(r => [r.trackingNumber, r]));
      const taken = await Order.find({
        'courierBooking.trackingNumber': { $in: numbers },
        _id: { $nin: group.map(o => o._id) }
      }).select('courierBooking.trackingNumber');
      const takenCount = new Map();
      for (const t of taken) {
        const n = t.courierBooking.trackingNumber;
        takenCount.set(n, (takenCount.get(n) ?? 0) + 1);
      }

      for (const o of group) {
        tally.checked += 1;
        const number = numberOf(o);
        const verdict = judgeParcel(o, parcels.get(number), {
          others: takenCount.get(number) ?? 0,
          typedOn: typed.get(number)
        });
        if (!verdict.ok) {
          tally.skipped += 1;
          await Order.updateOne(
            { _id: o._id },
            { $set: { adoptTry: { at: new Date(), reason: verdict.reason } } },
            { timestamps: false }
          );
          continue;
        }
        const parcel = parcels.get(number);
        // The condition keeps two passes (or a person booking at the same moment) from both writing.
        const done = await Order.updateOne(
          {
            _id: o._id,
            status: ORDER_STATUS.DISPATCHED,
            'courierBooking.trackingNumber': { $exists: false }
          },
          {
            $set: {
              courierBooking: {
                provider,
                trackingNumber: number,
                bookedAt: o.dispatchedAt ?? new Date(),
                courierStatus: parcel.status,
                courierStatusAt: new Date()
              },
              attemptsTracked: true
            },
            $unset: { adoptTry: 1 },
            $push: {
              activity: {
                kind: 'booking',
                text: 'Found this parcel at the courier and started following it',
                to: number,
                at: new Date(),
                system: true
              }
            }
          },
          { timestamps: false }
        );
        if (done.modifiedCount) tally.adopted += 1;
      }
    }
  }
  return tally;
};
