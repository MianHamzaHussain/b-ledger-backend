import Order from '../models/Order.js';
import { adapterFor } from './couriers/index.js';
import { courierCities, servedCity } from './couriers/booking.js';
import { notify } from './notify.js';
import { BEFORE_DISPATCH, NOTIFICATION_TYPES } from './constants.js';
import logger from './logger.js';

/**
 * Orders the courier refused only because it did not serve their city (`Order.awaitingCity`) are
 * re-checked against the courier's list read FRESH (not the cached copy). The moment a held order's
 * city is listed again it is marked open (`openedAt`, once) and people are told ONCE per business and
 * city, so nobody has to watch the courier's portal. Booking itself stays one tap (Book all) — it
 * creates a real parcel.
 */
export const checkHeldCities = async () => {
  const held = await Order.find({
    'awaitingCity.courier': { $exists: true },
    'awaitingCity.openedAt': { $exists: false },
    status: { $in: BEFORE_DISPATCH }
  })
    .select('business orderNumber awaitingCity')
    .lean();

  const byCourier = new Map();
  for (const o of held) {
    const key = String(o.awaitingCity.courier);
    if (!byCourier.has(key)) byCourier.set(key, []);
    byCourier.get(key).push(o);
  }

  const tally = { checked: held.length, opened: 0 };
  for (const [courierId, orders] of byCourier) {
    let cities;
    try {
      const { api } = await adapterFor(courierId);
      cities = await courierCities(courierId, api, { fresh: true });
    } catch (err) {
      logger.warn({ courier: courierId, err: err.message }, 'held cities not checked');
      continue;
    }

    const open = orders.filter(o => servedCity(cities, o.awaitingCity.city));
    if (!open.length) continue;

    // Marked in one conditional write, so two runs can not both announce the same orders.
    const marked = await Order.updateMany(
      { _id: { $in: open.map(o => o._id) }, 'awaitingCity.openedAt': { $exists: false } },
      { $set: { 'awaitingCity.openedAt': new Date() } },
      { timestamps: false }
    );
    if (!marked.modifiedCount) continue;
    tally.opened += marked.modifiedCount;

    // One message per business and city: "Mirpur Khas is open again — 4 orders can be booked".
    const groups = new Map();
    for (const o of open) {
      const key = `${o.business}|${o.awaitingCity.city}`;
      if (!groups.has(key))
        groups.set(key, { business: o.business, city: o.awaitingCity.city, n: 0 });
      groups.get(key).n += 1;
    }
    for (const { business, city, n } of groups.values()) {
      await notify({
        business,
        type: NOTIFICATION_TYPES.COURIER_CITY_OPEN,
        title: `${city} is open again — ${n} order${n === 1 ? '' : 's'} can be booked`,
        body: 'Open the Orders screen and book them in one tap.',
        link: '/orders'
      });
    }
  }
  return tally;
};
