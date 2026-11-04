import mongoose from 'mongoose';
import JournalEntry from '../models/JournalEntry.js';
import Order from '../models/Order.js';
import Business from '../models/Business.js';
import { accountBalance } from './ledger.js';
import { netOwed, chargeOf } from './courierWallet.js';
import { ORDER_STATUS, PAYMENT_STATUS } from './constants.js';

/**
 * The courier's wallet read parcel by parcel — which tracking numbers were paid and for how much, which were
 * charged, and what is still to come. Every figure is one the books already hold (the wallet's own entries, and each
 * parcel's recorded charge); nothing is posted here.
 *
 *   paid            delivered, the courier paid it:   + COD − charges − taxes
 *   charge          taken off the wallet:             − the charge (a return, or a delivered parcel with no cash)
 *   owed            delivered, not paid yet:          + what it will pay (blank while the fee is not known)
 *   charge-pending  charged, not yet on the wallet:   − the charge
 *
 * Two reads, so a long history never loads at once: a light SUMMARY (where the wallet stands, and how many parcels
 * each tab holds) and a PAGE of parcels for one tab, newest first.
 */

const FIELDS = [
  'orderNumber',
  'courier',
  'customerName',
  'status',
  'codAmount',
  'deliveryChargePaisa',
  'returnChargePaisa',
  'saleEntry',
  'courierSettlement',
  'deliveredAt',
  'returnedAt',
  'trackingId',
  'courierBooking.trackingNumber',
  'courierBooking.walletPaisa',
  'courierBooking.settlementDate',
  'courierBooking.walletChargeEntry'
];

const NO_CASH_CHARGE = [
  { status: ORDER_STATUS.RETURNED, returnChargePaisa: { $gt: 0 } },
  { status: ORDER_STATUS.DELIVERED, codAmount: { $lte: 0 }, deliveryChargePaisa: { $gt: 0 } }
];

const toId = value => new mongoose.Types.ObjectId(String(value));
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const trackingOf = o => o.courierBooking?.trackingNumber ?? o.trackingId ?? null;

/** The wallet's own entries — what separates "the wallet paid it" from a parcel settled some other way. */
const walletEntries = (business, wallet) =>
  JournalEntry.find({ business, 'lines.account': wallet._id }).select('_id date').lean();

/** What each kind of parcel looks like in the orders collection. */
const kindFilters = ids => ({
  paid: { courierSettlement: { $in: ids } },
  charges: { 'courierBooking.walletChargeEntry': { $in: ids } },
  owed: {
    status: ORDER_STATUS.DELIVERED,
    paymentStatus: PAYMENT_STATUS.UNPAID,
    codAmount: { $gt: 0 },
    'courierBooking.trackingNumber': { $exists: true }
  },
  pending: {
    'courierBooking.walletChargeEntry': { $exists: false },
    'courierBooking.trackingNumber': { $exists: true },
    $or: NO_CASH_CHARGE
  }
});

const tabFilter = (tab, f) => {
  if (tab === 'paid') return f.paid;
  if (tab === 'charges') return f.charges;
  if (tab === 'upcoming') return { $or: [f.owed, f.pending] };
  return { $or: [f.paid, f.charges, f.owed, f.pending] };
};

/** A parcel recorded before its amount was kept is read back from its sale entry, as the recorder did. */
const saleEntriesFor = async orders => {
  const needed = orders.filter(o => o.saleEntry && !(o.courierBooking?.walletPaisa >= 0));
  if (!needed.length) return new Map();
  const sales = await JournalEntry.find({ _id: { $in: needed.map(o => o.saleEntry) } }).lean();
  return new Map(sales.map(e => [String(e._id), e]));
};

const expectedOf = (order, biz, sales) => Math.max(0, netOwed(order, biz?.codTax, sales));

/** Where the wallet stands: what is in it, what is still to come, what will be taken, and the tabs' counts. */
export const courierWalletSummary = async (business, wallet) => {
  const base = { business, courier: wallet.courier };
  const entries = await walletEntries(business, wallet);
  const ids = entries.map(e => e._id);
  const f = kindFilters(ids);

  const [owedOrders, pendingOrders, paidCount, chargesCount, biz, walletPaisa] = await Promise.all([
    Order.find({ ...base, ...f.owed })
      .select(FIELDS.join(' '))
      .lean(),
    Order.find({ ...base, ...f.pending })
      .select('status returnChargePaisa deliveryChargePaisa')
      .lean(),
    ids.length ? Order.countDocuments({ ...base, ...f.paid }) : 0,
    ids.length ? Order.countDocuments({ ...base, ...f.charges }) : 0,
    Business.findById(business).select('codTax').lean(),
    accountBalance(business, wallet._id)
  ]);

  const sales = await saleEntriesFor(owedOrders);
  let owedPaisa = 0;
  let feeUnknown = 0;
  for (const o of owedOrders) {
    // Without a known fee the figure would be overstated, so it is left out and counted instead.
    if (o.deliveryChargePaisa == null) feeUnknown += 1;
    else owedPaisa += expectedOf(o, biz, sales);
  }
  const pendingChargesPaisa = pendingOrders.reduce((sum, o) => sum + (chargeOf(o) ?? 0), 0);

  const counts = {
    paid: paidCount,
    charges: chargesCount,
    upcoming: owedOrders.length + pendingOrders.length
  };
  return {
    walletPaisa,
    owedPaisa,
    pendingChargesPaisa,
    willGetPaisa: walletPaisa + owedPaisa - pendingChargesPaisa,
    feeUnknown,
    counts: { ...counts, all: counts.paid + counts.charges + counts.upcoming }
  };
};

/** When a parcel was last settled, charged, returned or delivered — what "newest first" sorts on. */
const SORT_AT = {
  $ifNull: [
    '$courierBooking.codSettledAt',
    {
      $ifNull: [
        '$courierBooking.walletChargedAt',
        { $ifNull: ['$returnedAt', { $ifNull: ['$deliveredAt', '$createdAt'] }] }
      ]
    }
  ]
};

/**
 * One page of parcels for a tab, newest first. `search` matches the order number, the tracking number or the
 * customer's name. Returns `{ total, rows }`; amounts are paisa.
 */
export const courierWalletParcels = async (
  business,
  wallet,
  { tab = 'all', search = '', page = 1, limit = 25 } = {}
) => {
  const entries = await walletEntries(business, wallet);
  const ids = entries.map(e => e._id);
  const dateOf = new Map(entries.map(e => [String(e._id), e.date]));
  const f = kindFilters(ids);

  const term = String(search).trim();
  const rx = term ? new RegExp(escapeRegex(term), 'i') : null;
  const match = {
    business: toId(business),
    courier: wallet.courier,
    $and: [
      tabFilter(tab, f),
      ...(rx
        ? [
            {
              $or: [
                { orderNumber: rx },
                { customerName: rx },
                { 'courierBooking.trackingNumber': rx },
                { trackingId: rx }
              ]
            }
          ]
        : [])
    ]
  };

  const [total, docs, biz] = await Promise.all([
    Order.countDocuments(match),
    Order.aggregate([
      { $match: match },
      { $addFields: { sortAt: SORT_AT } },
      { $sort: { sortAt: -1, _id: -1 } },
      { $skip: (page - 1) * limit },
      { $limit: limit },
      { $project: Object.fromEntries(FIELDS.map(name => [name, 1])) }
    ]),
    Business.findById(business).select('codTax').lean()
  ]);

  const sales = await saleEntriesFor(docs);
  const rows = docs.map(o => {
    const isPaid = dateOf.has(String(o.courierSettlement));
    const chargeEntry = String(o.courierBooking?.walletChargeEntry);
    const isCharge = dateOf.has(chargeEntry);
    const isNoCash =
      o.status === ORDER_STATUS.RETURNED ||
      (o.status === ORDER_STATUS.DELIVERED && !(Number(o.codAmount) > 0));
    const kind = isPaid ? 'paid' : isCharge ? 'charge' : isNoCash ? 'charge-pending' : 'owed';

    let amountPaisa;
    if (kind === 'paid') amountPaisa = o.courierBooking?.walletPaisa ?? expectedOf(o, biz, sales);
    else if (kind === 'owed') {
      amountPaisa = o.deliveryChargePaisa == null ? null : expectedOf(o, biz, sales);
    } else amountPaisa = -(chargeOf(o) ?? 0);

    const date =
      kind === 'paid'
        ? dateOf.get(String(o.courierSettlement))
        : kind === 'charge'
          ? dateOf.get(chargeEntry)
          : kind === 'charge-pending'
            ? (o.returnedAt ?? o.deliveredAt)
            : o.deliveredAt;
    return {
      order: o._id,
      orderNumber: o.orderNumber,
      tracking: trackingOf(o),
      customerName: o.customerName,
      kind,
      reason: kind.startsWith('charge')
        ? o.status === ORDER_STATUS.RETURNED
          ? 'returned'
          : 'no-cash'
        : undefined,
      date: date ?? null,
      settledOn: o.courierBooking?.settlementDate ?? null,
      codPaisa: Math.round((Number(o.codAmount) || 0) * 100),
      amountPaisa
    };
  });
  return { total, rows };
};
