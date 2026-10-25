import Order from '../../models/Order.js';
import ErrorResponse from '../errorResponse.js';
import { isMobile, normalizePhone } from '../phone.js';
import { adapterFor } from './index.js';

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

/** "Kurta (M) ×2, Lawn Suit" — what PostEx prints as the parcel's contents. */
const contents = order =>
  [
    ...order.items.map(
      i =>
        `${i.productName}${i.variantLabel && i.variantLabel !== 'Default' ? ` (${i.variantLabel})` : ''}${i.quantity > 1 ? ` x${i.quantity}` : ''}`
    ),
    ...(order.customWork ?? []).map(w => w.description)
  ]
    .join(', ')
    .slice(0, 300);

/** What the courier needs, built from the order — every field it asks for in the guide. */
export const parcelFor = (order, pickupAddressCode) => {
  const phone = normalizePhone(order.contactNumber);
  if (!isMobile(phone)) {
    throw new ErrorResponse(
      'PostEx needs the customer’s mobile number (03xx xxxxxxx). Correct the number on the order first.',
      400
    );
  }
  if (!order.deliveryAddress?.trim()) {
    throw new ErrorResponse('Add the delivery address on the order before booking a courier', 400);
  }
  if (!order.city?.trim()) {
    throw new ErrorResponse('Add the customer’s city on the order before booking a courier', 400);
  }
  const pieces =
    order.items.reduce((sum, i) => sum + i.quantity, 0) + (order.customWork?.length ?? 0);
  return {
    orderRefNumber: String(order.orderNumber),
    invoicePayment: order.codAmount,
    orderDetail: contents(order),
    customerName: order.customerName,
    customerPhone: phone,
    deliveryAddress: order.deliveryAddress.trim(),
    transactionNotes: order.customerNote ?? '',
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
export const bookParcel = async (order, courierId) => {
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

  const parcel = parcelFor(order, party.integration.pickupAddressCode);
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
            courierStatusAt: new Date()
          },
          trackingId: made.trackingNumber
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
