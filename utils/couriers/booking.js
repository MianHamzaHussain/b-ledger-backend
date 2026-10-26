import Order from '../../models/Order.js';
import ErrorResponse from '../errorResponse.js';
import { isMobile, normalizePhone } from '../phone.js';
import { pakistanDay } from '../pakistanDay.js';
import { adapterFor } from './index.js';
import { liveItemNames, nameUpdates } from '../orderNames.js';

/**
 * Book an order's parcel with the courier's own service and keep what comes back.
 *
 * The order has not moved yet when this runs: if the courier says no, the caller leaves the order
 * as it was and the message says why. If the courier says yes, the tracking number is saved on the
 * order at once — before anything else can fail — so a retry (or a second tap) finds that booking
 * and never makes a second parcel.
 */
const CITY_TTL_MS = 6 * 60 * 60 * 1000;
const cityCache = new Map();
/** A booking claimed longer ago than this is a crashed one, not an in-flight one. */
const LOCK_MS = 60_000;

export const clearCityCache = () => cityCache.clear();

/** The cities the courier delivers to, remembered for a while — the list rarely changes. */
const deliveryCities = async (partyId, api) => {
  const key = String(partyId);
  const hit = cityCache.get(key);
  if (hit && Date.now() - hit.at < CITY_TTL_MS) return hit.names;
  const names = new Set((await api.cities('delivery')).map(c => c.trim().toLowerCase()));
  cityCache.set(key, { names, at: Date.now() });
  return names;
};

/** The slip's Remarks box is small; PostEx documents no limit, so we keep what it can print. */
export const REMARKS_MAX = 250;

/**
 * "Kurta (M) ×2, Lawn Suit" — what PostEx prints as the parcel's contents. `names` are the products'
 * current names (one per line); without them the order's own saved names are used.
 */
const contents = (order, names = []) =>
  [
    ...order.items.map(
      (i, index) =>
        `${names[index] ?? i.productName}${i.variantLabel && i.variantLabel !== 'Default' ? ` (${i.variantLabel})` : ''}${i.quantity > 1 ? ` x${i.quantity}` : ''}`
    ),
    ...(order.customWork ?? []).map(w => w.description)
  ]
    .join(', ')
    .slice(0, 300);

/** Everything wrong with the order for a courier, in plain words, in the order a person would fix it. */
export const parcelProblems = order => {
  const problems = [];
  if (!isMobile(normalizePhone(order.contactNumber))) {
    problems.push(
      'PostEx needs the customer’s mobile number (03xx xxxxxxx). Correct the number on the order first.'
    );
  }
  if (!order.deliveryAddress?.trim()) {
    problems.push('Add the delivery address on the order before booking a courier');
  }
  if (!order.city?.trim()) {
    problems.push('Add the customer’s city on the order before booking a courier');
  }
  return problems;
};

/**
 * What the courier needs, built from the order — every field it asks for in the guide. `remarks` is what
 * the slip's Remarks box prints (default: what the customer asked for); `names` the products' current names.
 */
export const parcelFor = (order, pickupAddressCode, { names, remarks } = {}) => {
  const [problem] = parcelProblems(order);
  if (problem) throw new ErrorResponse(problem, 400);
  const phone = normalizePhone(order.contactNumber);
  const pieces =
    order.items.reduce((sum, i) => sum + i.quantity, 0) + (order.customWork?.length ?? 0);
  return {
    orderRefNumber: String(order.orderNumber),
    invoicePayment: order.codAmount,
    orderDetail: contents(order, names),
    customerName: order.customerName,
    customerPhone: phone,
    deliveryAddress: order.deliveryAddress.trim(),
    // Only what the customer asked for — the shop's own internal note is never sent.
    transactionNotes: (remarks ?? order.customerNote ?? '').trim().slice(0, REMARKS_MAX),
    cityName: order.city,
    invoiceDivision: 1,
    items: Math.max(1, pieces),
    pickupAddressCode,
    orderType: 'Normal'
  };
};

/**
 * Book `order` with its courier. Returns `{ trackingNumber, provider, already }` — `already` is
 * true when this order was booked earlier and nothing new was created.
 */
export const bookParcel = async (order, courierId, { remarks } = {}) => {
  const { api, provider, party } = await adapterFor(courierId);

  const earlier = order.courierBooking;
  if (earlier?.trackingNumber && earlier.provider === provider) {
    return { trackingNumber: earlier.trackingNumber, provider, already: true };
  }
  if (!party.integration.pickupAddressCode) {
    throw new ErrorResponse(
      'Choose which pickup address to book from in this courier’s settings',
      400
    );
  }

  // The slip must carry the article's name as it is called NOW, not as it was when the order was saved.
  const names = await liveItemNames(order);
  const parcel = parcelFor(order, party.integration.pickupAddressCode, { names, remarks });
  const cities = await deliveryCities(courierId, api);
  if (!cities.has(parcel.cityName.trim().toLowerCase())) {
    throw new ErrorResponse(
      `${provider === 'postex' ? 'PostEx' : 'This courier'} does not deliver to ${parcel.cityName}`,
      400
    );
  }

  // One booking at a time per order, and never a second one: the claim only succeeds while the order
  // has no tracking number AND nobody else holds it, so a double tap (or a retry after the first
  // one finished a moment ago) can not reach the courier twice.
  const claim = await Order.updateOne(
    {
      _id: order._id,
      'courierBooking.trackingNumber': { $exists: false },
      $or: [
        { 'courierBooking.lockedAt': { $exists: false } },
        { 'courierBooking.lockedAt': { $lt: new Date(Date.now() - LOCK_MS) } }
      ]
    },
    { $set: { 'courierBooking.lockedAt': new Date() } },
    { timestamps: false }
  );
  if (claim.modifiedCount !== 1) {
    const now = await Order.findById(order._id).select('courierBooking');
    if (now?.courierBooking?.trackingNumber) {
      return { trackingNumber: now.courierBooking.trackingNumber, provider, already: true };
    }
    throw new ErrorResponse('This order is being booked right now — wait a moment', 409);
  }

  try {
    const made = await api.createOrder(parcel);
    // Saved at once, before anything else can fail, so a retry finds it.
    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          courierBooking: {
            provider,
            trackingNumber: made.trackingNumber,
            bookedAt: new Date(),
            courierStatus: made.orderStatus ?? 'UnBooked',
            courierStatusAt: new Date(),
            // What PostEx was actually given, so the order can say so (and notice a later edit).
            remarks: parcel.transactionNotes,
            sentContents: parcel.orderDetail
          },
          trackingId: made.trackingNumber,
          // From here the order carries the names the slip shows.
          ...nameUpdates(order, names)
        }
      },
      { timestamps: false }
    );
    return { trackingNumber: made.trackingNumber, provider, already: false };
  } catch (err) {
    await Order.updateOne(
      { _id: order._id },
      { $unset: { 'courierBooking.lockedAt': 1 } },
      { timestamps: false }
    );
    throw err;
  }
};

const LOOKBACK_DAYS = 30;

/**
 * Parcels already made on the courier's own site and not yet picked up, that belong to this order's
 * customer (matched on phone number) — so the person picks one instead of pasting a tracking number.
 * Ones already attached to another order are left out.
 */
export const findUnbookedFor = async (order, courierId) => {
  const { api } = await adapterFor(courierId);
  const end = new Date();
  const start = new Date(end.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const rows = await api.unbooked({ startDate: pakistanDay(start), endDate: pakistanDay(end) });
  const phone = normalizePhone(order.contactNumber);
  const mine = rows.filter(r => r.trackingNumber && normalizePhone(r.customerPhone) === phone);
  if (!mine.length) return [];
  const taken = await Order.find({
    'courierBooking.trackingNumber': { $in: mine.map(r => r.trackingNumber) }
  }).select('courierBooking.trackingNumber');
  const used = new Set(taken.map(o => o.courierBooking.trackingNumber));
  return mine
    .filter(r => !used.has(r.trackingNumber))
    .map(r => ({
      trackingNumber: r.trackingNumber,
      orderRefNumber: r.orderRefNumber,
      customerPhone: r.customerPhone,
      cityName: r.cityName,
      invoicePayment: r.invoicePayment
    }));
};

/**
 * Use a parcel that already exists at the courier as this order's booking: the same record
 * `bookParcel` leaves, so the status check follows it from here. Refuses a number the courier does
 * not know, or one that already belongs to another order.
 */
export const attachParcel = async (order, courierId, trackingNumber) => {
  const { api, provider } = await adapterFor(courierId);
  const known = await api.track(trackingNumber).catch(() => null);
  if (!known) {
    throw new ErrorResponse('The courier does not know that tracking number', 400);
  }
  const elsewhere = await Order.exists({
    _id: { $ne: order._id },
    'courierBooking.trackingNumber': trackingNumber
  });
  if (elsewhere) {
    throw new ErrorResponse('That parcel is already attached to another order', 409);
  }
  await Order.updateOne(
    { _id: order._id },
    {
      $set: {
        courierBooking: {
          provider,
          trackingNumber,
          bookedAt: new Date(),
          courierStatus: known.status,
          courierStatusAt: new Date()
        },
        trackingId: trackingNumber
      }
    },
    { timestamps: false }
  );
  return { trackingNumber, provider };
};

/**
 * What the courier WOULD receive for this order — the same parcel `bookParcel` builds, with nothing sent
 * and nothing saved — plus every problem in plain words. The dispatch screen shows it so nobody books
 * blind: the article name, the remarks, the amount and the city are all visible before the tap.
 */
export const previewParcel = async (order, courierId, { remarks } = {}) => {
  const { api, party } = await adapterFor(courierId, { requireEnabled: false });
  const names = await liveItemNames(order);
  const problems = parcelProblems(order);

  let parcel = null;
  if (!problems.length) {
    parcel = parcelFor(order, party.integration?.pickupAddressCode ?? '', { names, remarks });
    // The courier's list of cities is a network call: if it fails the preview still works, it just can not say.
    try {
      const cities = await deliveryCities(courierId, api);
      if (!cities.has(parcel.cityName.trim().toLowerCase())) {
        problems.push(`PostEx does not deliver to ${parcel.cityName}`);
      }
    } catch {
      /* not checked — the booking itself will check again */
    }
  }
  if (!party.integration?.pickupAddressCode) {
    problems.push('Choose which pickup address to book from in this courier’s settings');
  }

  return {
    contents: parcel?.orderDetail ?? '',
    remarks: parcel?.transactionNotes ?? (remarks ?? order.customerNote ?? '').trim(),
    customerName: order.customerName,
    phone: parcel?.customerPhone ?? '',
    city: order.city ?? '',
    deliveryAddress: order.deliveryAddress ?? '',
    amount: order.codAmount,
    pieces: parcel?.items ?? 0,
    pickup: party.integration?.pickupAddressLabel ?? '',
    problems
  };
};
