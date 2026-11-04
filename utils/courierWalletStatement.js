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
 * "paid" and "charge" are history (limited to the dates asked for); "owed" and "charge-pending" are today's picture.
 */
const ROW_CAP = 500;

const FIELDS =
  'orderNumber courier customerName status codAmount deliveryChargePaisa returnChargePaisa saleEntry courierSettlement deliveredAt returnedAt courierBooking.trackingNumber courierBooking.walletPaisa courierBooking.settlementDate courierBooking.walletChargeEntry trackingId';

const NO_CASH_CHARGE = [
  { status: ORDER_STATUS.RETURNED, returnChargePaisa: { $gt: 0 } },
  { status: ORDER_STATUS.DELIVERED, codAmount: { $lte: 0 }, deliveryChargePaisa: { $gt: 0 } }
];

const trackingOf = o => o.courierBooking?.trackingNumber ?? o.trackingId ?? null;

const row = (o, kind, date, amountPaisa) => ({
  order: o._id,
  orderNumber: o.orderNumber,
  tracking: trackingOf(o),
  customerName: o.customerName,
  kind,
  date,
  settledOn: o.courierBooking?.settlementDate ?? null,
  reason: kind.startsWith('charge')
    ? o.status === ORDER_STATUS.RETURNED
      ? 'returned'
      : 'no-cash'
    : undefined,
  codPaisa: Math.round((Number(o.codAmount) || 0) * 100),
  amountPaisa
});

const newestFirst = (a, b) => new Date(b.date ?? 0) - new Date(a.date ?? 0);

export const courierWalletStatement = async (business, wallet, { from, to } = {}) => {
  const base = { business, courier: wallet.courier };

  const dateMatch = {};
  if (from) dateMatch.$gte = from;
  if (to) dateMatch.$lte = to;
  const entries = await JournalEntry.find({
    business,
    'lines.account': wallet._id,
    ...(from || to ? { date: dateMatch } : {})
  })
    .select('_id date')
    .lean();
  const entryDate = new Map(entries.map(e => [String(e._id), e.date]));
  const ids = entries.map(e => e._id);

  const [history, owedOrders, pendingOrders, biz, walletPaisa] = await Promise.all([
    ids.length
      ? Order.find({
          ...base,
          $or: [
            { courierSettlement: { $in: ids } },
            { 'courierBooking.walletChargeEntry': { $in: ids } }
          ]
        })
          .select(FIELDS)
          .lean()
      : [],
    Order.find({
      ...base,
      status: ORDER_STATUS.DELIVERED,
      paymentStatus: PAYMENT_STATUS.UNPAID,
      codAmount: { $gt: 0 },
      'courierBooking.trackingNumber': { $exists: true }
    })
      .select(FIELDS)
      .lean(),
    Order.find({
      ...base,
      'courierBooking.walletChargeEntry': { $exists: false },
      'courierBooking.trackingNumber': { $exists: true },
      $or: NO_CASH_CHARGE
    })
      .select(FIELDS)
      .lean(),
    Business.findById(business).select('codTax').lean(),
    accountBalance(business, wallet._id)
  ]);

  // A parcel recorded before its amount was kept: read it back from the sale entry, as the recorder did.
  const needSale = [...history, ...owedOrders].filter(
    o => o.saleEntry && !(o.courierBooking?.walletPaisa >= 0)
  );
  const sales = needSale.length
    ? await JournalEntry.find({ _id: { $in: needSale.map(o => o.saleEntry) } }).lean()
    : [];
  const bookedBy = new Map(sales.map(e => [String(e._id), e]));
  const expected = o => Math.max(0, netOwed(o, biz?.codTax, bookedBy));

  const rows = [];
  for (const o of history) {
    if (entryDate.has(String(o.courierSettlement))) {
      const paisa = o.courierBooking?.walletPaisa ?? expected(o);
      rows.push(row(o, 'paid', entryDate.get(String(o.courierSettlement)), paisa));
    }
    const chargeEntry = o.courierBooking?.walletChargeEntry;
    if (chargeEntry && entryDate.has(String(chargeEntry))) {
      rows.push(row(o, 'charge', entryDate.get(String(chargeEntry)), -(chargeOf(o) ?? 0)));
    }
  }

  let owedPaisa = 0;
  let feeUnknown = 0;
  for (const o of owedOrders) {
    // Without a known fee the figure would be overstated, so it is left blank and not counted.
    const isKnown = o.deliveryChargePaisa != null;
    const paisa = isKnown ? expected(o) : null;
    if (isKnown) owedPaisa += paisa;
    else feeUnknown += 1;
    rows.push(row(o, 'owed', o.deliveredAt, paisa));
  }

  let pendingChargesPaisa = 0;
  for (const o of pendingOrders) {
    const paisa = chargeOf(o) ?? 0;
    pendingChargesPaisa += paisa;
    rows.push(row(o, 'charge-pending', o.returnedAt ?? o.deliveredAt, -paisa));
  }

  rows.sort(newestFirst);
  return {
    walletPaisa,
    owedPaisa,
    pendingChargesPaisa,
    willGetPaisa: walletPaisa + owedPaisa - pendingChargesPaisa,
    feeUnknown,
    total: rows.length,
    rows: rows.slice(0, ROW_CAP)
  };
};
