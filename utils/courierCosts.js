import Business from '../models/Business.js';
import CourierReceipt from '../models/CourierReceipt.js';
import JournalEntry from '../models/JournalEntry.js';
import Order from '../models/Order.js';
import ErrorResponse from './errorResponse.js';
import { accountByCode, ensureChart, CODES } from './chartOfAccounts.js';
import { postEntry } from './ledger.js';
import { computeRemittance, orderLabel } from './orderPosting.js';
import { toPaisa } from './money.js';
import { JOURNAL_SOURCES, ORDER_STATUS } from './constants.js';

/**
 * What the courier charges for a customer's parcels — so a refund or an exchange can recover it instead of the
 * business absorbing it. One parcel costs its delivery charge (shipping + GST) plus the COD tax on that parcel's
 * COD. The tax is on the COD ONLY: an advance paid to us directly carries no courier tax, which is exactly what
 * PostEx deducts. The best figure wins: PostEx's own receipt, then a courier invoice, then the status check's
 * figure, then an estimate. Only the first two are FINAL — a payout waits for them (utils/courierCosts settle).
 */

/** Whole-rupee COD that, after the tax on itself, still covers `basePaisa`. 0 when nothing is to be covered. */
export const grossUpCod = (basePaisa, taxPercent) => {
  if (!(basePaisa > 0)) return 0;
  const rate = Math.max(0, Number(taxPercent) || 0) / 100;
  const covers = codPaisa => codPaisa - Math.round(codPaisa * rate) >= basePaisa;
  let cod = Math.ceil(basePaisa / (1 - Math.min(rate, 0.99)) / 100) * 100;
  // The estimate above can be a rupee out because tax is rounded to the paisa: settle on the smallest that covers.
  while (cod > 100 && covers(cod - 100)) cod -= 100;
  while (!covers(cod)) cod += 100;
  return cod;
};

/** The business's COD tax as one percentage (2 % withholding + 2 % sales tax = the "4 %"). */
export const taxPercentOf = codTax =>
  (Number(codTax?.whtPercent) || 0) + (Number(codTax?.salesTaxPercent) || 0);

/** One parcel's cost, from the best figure available. */
export const parcelCost = (
  order,
  { codTax, receiptRow, fromInvoice, estimateDeliveryPaisa = 0 }
) => {
  if (receiptRow) {
    return {
      deliveryPaisa: receiptRow.shippingPaisa + receiptRow.gstPaisa,
      taxPaisa: receiptRow.deductionPaisa,
      source: 'receipt',
      isFinal: true
    };
  }
  const known = order.deliveryChargePaisa;
  const deliveryPaisa = known ?? estimateDeliveryPaisa;
  const { whtPaisa, salesTaxPaisa } = computeRemittance(toPaisa(order.codAmount), 0, codTax || {});
  const taxPaisa = whtPaisa + salesTaxPaisa;
  if (known == null) return { deliveryPaisa, taxPaisa, source: 'estimate', isFinal: false };
  return {
    deliveryPaisa,
    taxPaisa,
    source: fromInvoice ? 'invoice' : 'tracking',
    isFinal: Boolean(fromInvoice)
  };
};

const INVOICE_KINDS = new Set([JOURNAL_SOURCES.COURIER_INVOICE, JOURNAL_SOURCES.COURIER_RECEIPT]);

/** PostEx's receipt rows for these orders (by order) and for these tracking numbers (a reversal parcel). */
const loadReceiptRows = async (business, orderIds, trackings) => {
  const docs = await CourierReceipt.find({
    business,
    $or: [
      { 'rows.order': { $in: orderIds } },
      ...(trackings.length ? [{ 'rows.tracking': { $in: trackings } }] : [])
    ]
  })
    .select('rows')
    .lean();
  const byOrder = new Map();
  const byTracking = new Map();
  for (const doc of docs) {
    for (const row of doc.rows) {
      if (row.outcome !== 'applied') continue;
      if (row.order) byOrder.set(String(row.order), row);
      byTracking.set(row.tracking, row);
    }
  }
  return { byOrder, byTracking };
};

/** Which of these orders had their charge or settlement come from a courier invoice (or PostEx receipt). */
const invoiceBacked = async orders => {
  const ids = orders.flatMap(o => [o.deliveryChargeEntry, o.courierSettlement]).filter(Boolean);
  if (!ids.length) return new Set();
  const entries = await JournalEntry.find({ _id: { $in: ids } })
    .select('source')
    .lean();
  const fromInvoice = new Set(
    entries.filter(e => INVOICE_KINDS.has(e.source?.kind)).map(e => String(e._id))
  );
  return new Set(
    orders
      .filter(
        o =>
          fromInvoice.has(String(o.deliveryChargeEntry)) ||
          fromInvoice.has(String(o.courierSettlement))
      )
      .map(o => String(o._id))
  );
};

const lineOf = (label, amountPaisa, cost, parcel) => ({
  label,
  amountPaisa,
  source: cost.source,
  isFinal: cost.isFinal,
  parcel
});

/**
 * Every courier cost to recover for this order, as plain lines.
 *   a refunded order   → its own parcel (+ the return pickup when WE booked it on our courier)
 *   a replacement      → the original's parcel, the swap's reversal if PostEx billed one, and its own parcel
 * Anything else has none. Lines with a zero amount are left out.
 */
export const costsFor = async (order, { asRefund = false, pickupBy } = {}) => {
  const business = await Business.findById(order.business).select('codTax').lean();
  const codTax = business?.codTax || {};
  // `asRefund` prices a delivered order that is about to be refunded (the quote), before it is marked refunded.
  const isRefund = asRefund || order.status === ORDER_STATUS.REFUNDED;
  const original = order.exchangeOf ? await Order.findById(order.exchangeOf).lean() : null;
  if (!isRefund && !original) return { lines: [], totalPaisa: 0, isFinal: true, waitingFor: [] };

  const parcels = isRefund ? [order] : [original, order];
  const reversalTracking = (isRefund ? order : original).reversalTrackingId;
  const rows = await loadReceiptRows(
    order.business,
    parcels.map(o => o._id),
    reversalTracking ? [reversalTracking] : []
  );
  const invoiced = await invoiceBacked(parcels);

  const costOf = (parcel, estimateDeliveryPaisa) =>
    parcelCost(parcel, {
      codTax,
      receiptRow: rows.byOrder.get(String(parcel._id)),
      fromInvoice: invoiced.has(String(parcel._id)),
      estimateDeliveryPaisa
    });
  const lines = [];
  const add = (label, amountPaisa, cost, parcel) => {
    if (amountPaisa > 0 || !cost.isFinal) lines.push(lineOf(label, amountPaisa, cost, parcel));
  };
  const parcelLines = (parcel, estimate) => {
    const cost = costOf(parcel, estimate);
    const name = `#${parcel.orderNumber}`;
    add(`Delivery charge — parcel ${name}`, cost.deliveryPaisa, cost, name);
    add(
      `${taxPercentOf(codTax)} % tax on COD — parcel ${name}`,
      cost.taxPaisa,
      { ...cost, isFinal: cost.isFinal },
      name
    );
    return cost;
  };

  const first = parcelLines(parcels[0], 0);

  if (isRefund) {
    // Only a pickup we booked on our own courier costs us; the customer's own courier is theirs.
    if ((pickupBy ?? order.returnShipping?.by) === 'us') {
      const row = reversalTracking ? rows.byTracking.get(reversalTracking) : null;
      const cost = row
        ? { deliveryPaisa: row.shippingPaisa + row.gstPaisa, source: 'receipt', isFinal: true }
        : order.returnChargePaisa != null && order.returnChargePaisa > 0
          ? {
              deliveryPaisa: order.returnChargePaisa,
              source: order.returnChargeEntry ? 'invoice' : 'tracking',
              isFinal: Boolean(order.returnChargeEntry)
            }
          : { deliveryPaisa: first.deliveryPaisa, source: 'estimate', isFinal: false };
      add('Return pickup', cost.deliveryPaisa, cost, 'return');
    }
  } else {
    // A swap's reversal is only a cost when PostEx actually billed it on a receipt.
    const row = reversalTracking ? rows.byTracking.get(reversalTracking) : null;
    if (row && String(row.order) !== String(original._id)) {
      add(
        'Return pickup',
        row.shippingPaisa + row.gstPaisa,
        { source: 'receipt', isFinal: true },
        'return'
      );
    }
    // The replacement: until it has its own charge, it is estimated at the original's; it is only final once
    // it is delivered and billed.
    const own = costOf(order, first.deliveryPaisa);
    const delivered = [
      ORDER_STATUS.DELIVERED,
      ORDER_STATUS.REFUNDED,
      ORDER_STATUS.EXCHANGED
    ].includes(order.status);
    const cost = { ...own, isFinal: own.isFinal && delivered };
    const name = `#${order.orderNumber}`;
    add(`Delivery charge — parcel ${name}`, cost.deliveryPaisa, cost, name);
    add(`${taxPercentOf(codTax)} % tax on COD — parcel ${name}`, cost.taxPaisa, cost, name);
  }

  // The parcel lines were added once for parcels[0]; for an exchange the loop above added the original and now the
  // replacement — nothing more to do for a refund.
  const totalPaisa = lines.reduce((sum, l) => sum + l.amountPaisa, 0);
  const waitingFor = [...new Set(lines.filter(l => !l.isFinal).map(l => l.parcel))];
  return { lines, totalPaisa, isFinal: waitingFor.length === 0, waitingFor };
};

/** Only a refunded order or a replacement has courier costs to take off what is paid back. */
export const needsCostSettlement = order =>
  order.status === ORDER_STATUS.REFUNDED || Boolean(order.exchangeOf);

const isAdmin = user => Boolean(user?.role?.fullAccess);

/**
 * Take the courier's costs off what the customer is owed, once, before any payout. A cost is only taken when PostEx
 * (or a courier invoice) has billed it; until then the payout waits. An admin may pay early on the estimate, or waive
 * the deductions, each with a reason. Posts ONE entry (Dr Advances from customers / Cr Charges kept from refunds) and
 * leaves a `kept` row per cost on the order, so what the customer is told adds up to what was booked.
 */
export const settleCourierCosts = async (
  order,
  { userId, user, early = false, waive = false, reason }
) => {
  if (!needsCostSettlement(order) || order.courierCosts?.settledAt) return order;
  const why = String(reason ?? '').trim();

  if (waive) {
    if (!isAdmin(user)) throw new ErrorResponse('Only an admin can waive the deductions', 403);
    if (!why) throw new ErrorResponse('Say why the deductions are waived', 400);
    order.courierCosts = { settledAt: new Date(), waived: true, reason: why, lines: [] };
    order.updatedBy = userId;
    await order.save();
    return order;
  }

  const costs = await costsFor(order);
  if (!costs.isFinal) {
    if (!early) {
      throw new ErrorResponse(
        `PostEx has not billed ${costs.waitingFor.join(', ')} yet — add its receipt first, or ask an admin to pay early`,
        400
      );
    }
    if (!isAdmin(user)) {
      throw new ErrorResponse('Only an admin can pay before PostEx has billed', 403);
    }
    if (!why) throw new ErrorResponse('Say why this is paid before PostEx has billed', 400);
  }

  const lines = costs.lines.filter(l => l.amountPaisa > 0);
  const totalPaisa = lines.reduce((sum, l) => sum + l.amountPaisa, 0);
  if (totalPaisa > order.refundDuePaisa) {
    throw new ErrorResponse(
      'The courier costs are more than what is due back — they belong on the replacement instead',
      400
    );
  }

  let entry = null;
  if (totalPaisa > 0) {
    await ensureChart(order.business);
    const label = `${orderLabel(order)} · ${order.customerName}`;
    entry = await postEntry({
      business: order.business,
      memo: `Courier costs kept back — ${label}`,
      source: { kind: JOURNAL_SOURCES.ORDER, ref: String(order._id) },
      lines: [
        {
          account: (await accountByCode(order.business, CODES.CUSTOMER_ADVANCES))._id,
          label,
          debitPaisa: totalPaisa
        },
        {
          account: (await accountByCode(order.business, CODES.CHARGES_KEPT))._id,
          label,
          creditPaisa: totalPaisa
        }
      ],
      userId
    });
    for (const line of lines) {
      order.customerMoney.push({
        kind: 'kept',
        amountPaisa: line.amountPaisa,
        accountName: line.label,
        date: new Date(),
        entry: entry._id,
        by: userId
      });
    }
  }
  order.courierCosts = {
    settledAt: new Date(),
    early: !costs.isFinal,
    reason: costs.isFinal ? undefined : why,
    lines: lines.map(({ label, amountPaisa, source }) => ({ label, amountPaisa, source }))
  };
  order.updatedBy = userId;
  // Saving re-derives what is due back, so the payout that follows is checked against the net.
  await order.save();
  return order;
};
