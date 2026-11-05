import Order from '../models/Order.js';
import Party from '../models/Party.js';
import { adapterFor } from './couriers/index.js';
import { notify } from './notify.js';
import { courierWalletFor } from './moneyAccounts.js';
import { NOTIFICATION_TYPES, ORDER_STATUS, PARTY_TYPES, PAYMENT_STATUS } from './constants.js';
import logger from './logger.js';

/**
 * "PostEx has paid — add its receipt." PostEx's API says, per parcel, only whether it has paid it (and the day); it
 * has no way to download the receipt (CPR) itself. So this check NEVER puts money anywhere — the receipt is the only
 * thing that fills the wallet (utils/courierReceipts.js). It only rings the bell, once per parcel, so someone downloads
 * the receipt from PostEx's portal and adds it. The parcel keeps `courierBooking.postexPaidOn`, which the wallet page
 * counts as "PostEx says paid, receipt not added yet" until a receipt settles it.
 */
const PER_RUN = 40;
const RECHECK_MS = 3 * 60 * 60 * 1000;

const asDate = value => {
  const d = value ? new Date(value) : null;
  return d && !Number.isNaN(d.getTime()) ? d : undefined;
};

const dayWords = date =>
  date.toLocaleDateString('en-PK', { day: 'numeric', month: 'short', timeZone: 'Asia/Karachi' });

/** One courier: ask about its delivered, unpaid parcels not yet on a receipt; ring once for the newly paid ones. */
const checkCourier = async (party, now) => {
  const { api } = await adapterFor(party._id);
  const candidates = await Order.find({
    business: party.business,
    courier: party._id,
    status: ORDER_STATUS.DELIVERED,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    codAmount: { $gt: 0 },
    'courierBooking.trackingNumber': { $exists: true },
    'courierBooking.cprNumber': { $exists: false },
    'courierBooking.postexPaidOn': { $exists: false },
    $or: [
      { 'courierBooking.paymentCheckedAt': { $exists: false } },
      { 'courierBooking.paymentCheckedAt': { $lt: new Date(now.getTime() - RECHECK_MS) } }
    ]
  })
    .select('courierBooking.trackingNumber')
    .sort({ 'courierBooking.paymentCheckedAt': 1, deliveredAt: -1 })
    .limit(PER_RUN)
    .lean();

  const paid = [];
  for (const order of candidates) {
    try {
      // One at a time: PostEx is asked per parcel, and a burst would trip its rate limit.
      // eslint-disable-next-line no-await-in-loop
      const answer = await api.paymentStatus(order.courierBooking.trackingNumber);
      const paidOn = answer.settled ? (asDate(answer.settlementDate) ?? now) : undefined;
      // eslint-disable-next-line no-await-in-loop
      await Order.updateOne(
        { _id: order._id },
        {
          $set: {
            'courierBooking.paymentCheckedAt': now,
            ...(paidOn ? { 'courierBooking.postexPaidOn': paidOn } : {})
          }
        },
        { timestamps: false }
      );
      if (paidOn) paid.push(paidOn);
    } catch (err) {
      logger.warn(
        { tracking: order.courierBooking.trackingNumber, err: err.message },
        'payment status not read'
      );
    }
  }

  if (paid.length) {
    // A courier connected before wallets were made on connecting has none yet: make it, so the bell's link opens the
    // page where the receipt is added.
    const wallet = await courierWalletFor(party.business, party, party.createdBy);
    const days = [...new Set(paid.map(dayWords))];
    await notify({
      business: party.business,
      type: NOTIFICATION_TYPES.COURIER_PAID,
      title: `${party.name} has paid ${paid.length} parcel${paid.length === 1 ? '' : 's'} — add its receipt`,
      body: `Paid on ${days.join(', ')}. Download the receipt (CPR) from your ${party.name} portal, then tap here and choose "Add PostEx receipt". Nothing goes into the wallet until you do.`,
      link: `/finance/courier-wallet?account=${wallet._id}`
    });
  }
  return { checked: candidates.length, paid: paid.length };
};

/** Every connected PostEx courier, about once an hour. One courier's failure never stops the others. */
export const checkCourierPayouts = async ({ now = new Date() } = {}) => {
  const parties = await Party.find({
    type: PARTY_TYPES.COURIER,
    'integration.provider': 'postex',
    'integration.isEnabled': true
  });
  const tally = { couriers: parties.length, checked: 0, paid: 0, errors: 0 };
  for (const party of parties) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const t = await checkCourier(party, now);
      tally.checked += t.checked;
      tally.paid += t.paid;
    } catch (err) {
      tally.errors += 1;
      logger.error({ courier: String(party._id), err }, 'courier payout check failed');
    }
  }
  return tally;
};
