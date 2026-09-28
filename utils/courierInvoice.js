import Order from '../models/Order.js';
import Business from '../models/Business.js';
import Party from '../models/Party.js';
import CourierInvoice from '../models/CourierInvoice.js';
import ErrorResponse from './errorResponse.js';
import { accountByCode, ensureChart, CODES } from './chartOfAccounts.js';
import { postEntry, reverseEntry } from './ledger.js';
import { computeRemittance, orderLabel } from './orderPosting.js';
import { toPaisa } from './money.js';
import { JOURNAL_SOURCES, ORDER_STATUS, PAYMENT_STATUS } from './constants.js';

/**
 * The courier's invoice — how COD and courier charges are actually settled.
 *
 * A courier bills per parcel (by tracking id) and pays weekly, and it may pay a
 * parcel's COD on one invoice and bill its charge on another (TCS deducts
 * charges one week, pays the COD the next). So each parcel has two things to
 * settle, independently:
 *
 *   • its COD      — a delivered order's cash, owed until an invoice pays it
 *   • its charges  — the delivery fee and/or the return (or exchange pickup) fee,
 *                    unknown until an invoice bills them
 *
 * A charge is OPEN while its amount on the order is unset; one entered at the
 * outcome, or by an earlier invoice, is already billed. Delivery booked the
 * sale with the COD owed net of FBR taxes (known rates) and no fee, so here:
 *
 *   Dr Money account (what arrived)         ┐
 *   Dr Delivery / Return charges (billed)   ├ Cr COD-receivable [courier]
 *                                           ┘   (received + charges)
 *
 * Whatever the courier paid short of (or over) the ticked items simply stays on
 * its balance, as with any courier payment.
 */

const ITEM_FIELDS =
  'orderNumber trackingId customerName city status paymentStatus codAmount deliveryChargePaisa returnChargePaisa deliveredAt returnedAt exchangedAt createdAt';

/** COD owed on a delivered order, and its parts (paisa). */
const codParts = (order, codTax) => {
  const { whtPaisa, salesTaxPaisa, bankPaisa } = computeRemittance(
    toPaisa(order.codAmount),
    0,
    codTax
  );
  return { codPaisa: toPaisa(order.codAmount), whtPaisa, salesTaxPaisa, netPaisa: bankPaisa };
};

const isCodOpen = o =>
  o.status === ORDER_STATUS.DELIVERED &&
  o.paymentStatus === PAYMENT_STATUS.UNPAID &&
  (o.codAmount || 0) > 0;
const isDeliveryChargeOpen = o =>
  (o.status === ORDER_STATUS.DELIVERED || o.status === ORDER_STATUS.EXCHANGED) &&
  o.deliveryChargePaisa == null;
const isReturnChargeOpen = o =>
  (o.status === ORDER_STATUS.RETURNED || o.status === ORDER_STATUS.EXCHANGED) &&
  o.returnChargePaisa == null;

/**
 * Everything still open with a courier, oldest first: each parcel with its COD
 * (if unpaid) and which of its charges are still to be billed.
 */
export const openCourierItems = async (business, courierId) => {
  const [orders, biz] = await Promise.all([
    Order.find({
      business,
      courier: courierId,
      status: { $in: [ORDER_STATUS.DELIVERED, ORDER_STATUS.RETURNED, ORDER_STATUS.EXCHANGED] }
    })
      .select(ITEM_FIELDS)
      .sort({ createdAt: 1 })
      .lean(),
    Business.findById(business).select('codTax').lean()
  ]);

  return orders
    .map(o => ({
      order: o._id,
      orderNumber: o.orderNumber,
      trackingId: o.trackingId,
      customerName: o.customerName,
      city: o.city,
      status: o.status,
      date: o.deliveredAt || o.returnedAt || o.exchangedAt || o.createdAt,
      cod: isCodOpen(o) ? codParts(o, biz?.codTax || {}) : null,
      deliveryChargeOpen: isDeliveryChargeOpen(o),
      returnChargeOpen: isReturnChargeOpen(o)
    }))
    .filter(i => i.cod || i.deliveryChargeOpen || i.returnChargeOpen);
};

/**
 * Record one courier invoice: the CODs it paid, the charges it billed, and what
 * actually arrived. Returns the entry and the expected-vs-received figures.
 */
export const recordCourierInvoice = async ({
  courier,
  invoiceNumber,
  invoiceDate,
  money,
  receivedPaisa,
  codOrderIds = [],
  charges = [],
  memo,
  userId
}) => {
  const business = courier.business;
  const number = String(invoiceNumber).trim();
  if (await CourierInvoice.exists({ business, courier: courier._id, invoiceNumber: number })) {
    throw new ErrorResponse(`Invoice ${number} from ${courier.name} is already recorded`, 400);
  }
  if (codOrderIds.length === 0 && charges.length === 0) {
    throw new ErrorResponse('Tick the parcels this invoice covers', 400);
  }

  // Each order and charge once, and only what is still open with THIS courier.
  const uniqueCod = [...new Set(codOrderIds.map(String))];
  const chargeKeys = new Set(charges.map(c => `${c.order}:${c.kind}`));
  if (uniqueCod.length !== codOrderIds.length || chargeKeys.size !== charges.length) {
    throw new ErrorResponse('A parcel is listed twice', 400);
  }
  const ids = [...new Set([...uniqueCod, ...charges.map(c => String(c.order))])];
  const orders = await Order.find({ _id: { $in: ids }, business, courier: courier._id });
  const byId = new Map(orders.map(o => [String(o._id), o]));

  const codOrders = uniqueCod.map(id => {
    const o = byId.get(id);
    if (!o || !isCodOpen(o)) {
      throw new ErrorResponse(
        `Order ${o?.orderNumber ?? ''} has no unpaid COD with this courier`,
        400
      );
    }
    return o;
  });
  const chargeRows = charges.map(c => {
    const o = byId.get(String(c.order));
    const open = o && (c.kind === 'delivery' ? isDeliveryChargeOpen(o) : isReturnChargeOpen(o));
    if (!open) {
      throw new ErrorResponse(
        `Order ${o?.orderNumber ?? ''} has no open ${c.kind} charge with this courier`,
        400
      );
    }
    return { order: o, kind: c.kind, amountPaisa: toPaisa(c.amount) };
  });

  await ensureChart(business);
  const biz = await Business.findById(business).select('codTax').lean();
  const codNetPaisa = codOrders.reduce((s, o) => s + codParts(o, biz?.codTax || {}).netPaisa, 0);
  const chargesPaisa = chargeRows.reduce((s, c) => s + c.amountPaisa, 0);
  const expectedPaisa = codNetPaisa - chargesPaisa;

  const acc = code => accountByCode(business, code);
  const lines = [];
  if (receivedPaisa > 0) lines.push({ account: money.account, debitPaisa: receivedPaisa });
  for (const c of chargeRows) {
    if (c.amountPaisa <= 0) continue;
    const isDelivery = c.kind === 'delivery';
    lines.push({
      account: (await acc(isDelivery ? CODES.DELIVERY_CHARGES : CODES.RETURN_CHARGES))._id,
      label: `${isDelivery ? 'Delivery charge' : 'Return charge'} · ${orderLabel(c.order)}`,
      debitPaisa: c.amountPaisa
    });
  }
  const creditPaisa = receivedPaisa + chargesPaisa;
  let entry = null;
  if (creditPaisa > 0) {
    lines.push({
      account: (await acc(CODES.COD_RECEIVABLE))._id,
      party: courier._id,
      label: `Invoice ${number}`,
      creditPaisa
    });
    entry = await postEntry({
      business,
      date: invoiceDate,
      memo: memo || `Invoice ${number} — ${courier.name}`,
      source: { kind: JOURNAL_SOURCES.COURIER_INVOICE, ref: String(courier._id) },
      lines,
      userId
    });
  }

  let invoice;
  try {
    invoice = await CourierInvoice.create({
      business,
      courier: courier._id,
      invoiceNumber: number,
      invoiceDate,
      entry: entry?._id,
      receivedPaisa,
      expectedPaisa,
      codOrders: codOrders.map(o => o._id),
      charges: chargeRows.map(c => ({
        order: c.order._id,
        kind: c.kind,
        amountPaisa: c.amountPaisa
      })),
      createdBy: userId
    });
  } catch (err) {
    // Someone recorded the same invoice a moment ago — undo ours.
    if (entry) await reverseEntry(entry._id, { userId, memo: `Duplicate of invoice ${number}` });
    if (err?.code === 11000) {
      throw new ErrorResponse(`Invoice ${number} from ${courier.name} is already recorded`, 400);
    }
    throw err;
  }

  // The parcels it settled.
  if (codOrders.length) {
    await Order.updateMany(
      { _id: { $in: codOrders.map(o => o._id) }, paymentStatus: PAYMENT_STATUS.UNPAID },
      { $set: { paymentStatus: PAYMENT_STATUS.PAID, courierSettlement: entry?._id } }
    );
  }
  for (const c of chargeRows) {
    const set =
      c.kind === 'delivery'
        ? { deliveryChargePaisa: c.amountPaisa, deliveryChargeEntry: entry?._id }
        : { returnChargePaisa: c.amountPaisa, returnChargeEntry: entry?._id };
    await Order.updateOne({ _id: c.order._id }, { $set: set });
  }

  // Remember where this courier's money lands, for its next invoice.
  if (receivedPaisa > 0 && !money.partner) {
    await Party.updateOne({ _id: courier._id }, { $set: { defaultMoneyAccount: money.account } });
  }

  return {
    invoice,
    entry,
    expectedPaisa,
    receivedPaisa,
    differencePaisa: receivedPaisa - expectedPaisa,
    codCount: codOrders.length,
    chargeCount: chargeRows.length
  };
};

/**
 * Undo an invoice's effect on its parcels — called when its entry is reversed:
 * its CODs read as unpaid again, its charges as open, and its number is free to
 * be entered again correctly.
 */
export const undoCourierInvoice = async entryId => {
  await Order.updateMany(
    { courierSettlement: entryId },
    { $set: { paymentStatus: PAYMENT_STATUS.UNPAID }, $unset: { courierSettlement: '' } }
  );
  await Order.updateMany(
    { deliveryChargeEntry: entryId },
    { $unset: { deliveryChargePaisa: '', deliveryChargeEntry: '' } }
  );
  await Order.updateMany(
    { returnChargeEntry: entryId },
    { $unset: { returnChargePaisa: '', returnChargeEntry: '' } }
  );
  await CourierInvoice.deleteOne({ entry: entryId });
};
