import Account from '../models/Account.js';
import Business from '../models/Business.js';
import CourierReceipt from '../models/CourierReceipt.js';
import JournalEntry from '../models/JournalEntry.js';
import Order from '../models/Order.js';
import ErrorResponse from './errorResponse.js';
import { accountByCode, ensureChart, CODES } from './chartOfAccounts.js';
import { postEntry } from './ledger.js';
import { courierWalletFor } from './moneyAccounts.js';
import { netOwed } from './courierWallet.js';
import { parseBusinessDate } from './pakistanDay.js';
import { JOURNAL_SOURCES, ORDER_STATUS, PAYMENT_STATUS } from './constants.js';
import logger from './logger.js';

/**
 * A PostEx receipt (CPR) added to the courier's wallet.
 *
 * PostEx pays each payout into the merchant's PostEx wallet; the merchant withdraws later. The wallet in B Ledger
 * mirrors that: a parcel's money goes onto it only from the receipt, with PostEx's own figures — never from a
 * calculation. For every parcel on the receipt the question is "what does the wallet hold for it now, and what
 * should it hold": it should hold exactly PostEx's net for the parcel (+ for a delivered one, − for a return or a
 * parcel with no cash), and this posts only the DIFFERENCE, so nothing is ever counted twice.
 *
 *   W   the courier's wallet            R   COD receivable [courier] — what the courier still owes
 *   DC  delivery charges (expense)      RC  return charges (expense)
 *
 *   paid        delivered, COD, unpaid          Dr W net · Cr R booked · the rest to DC (PostEx's fee and 4 % vs what was booked)
 *   topup       delivered, COD, paid by the old wallet job     only net − what it put on W, against DC
 *   charge      no cash / returned, charge not set      Dr DC|RC charge · Cr W charge
 *   moveCharge  charge already set (courier invoice), not on W     Dr R charge · Cr W charge, then the difference
 *   chargeDiff  charge already on W (old job)      only the difference
 *
 * A parcel that is not in B Ledger is IGNORED (the shop is not answerable for parcels made outside the app) and
 * listed with its total. One that B Ledger disagrees with (not yet delivered, already settled by a manual invoice, on
 * another receipt) waits as PENDING with the reason in words; fix it and add the same receipt again.
 */
const DELIVERED_ONCE = [ORDER_STATUS.DELIVERED, ORDER_STATUS.EXCHANGED, ORDER_STATUS.REFUNDED];
const LOCK_MS = 5 * 60 * 1000;

/** Positive paisa = debit, negative = credit. Zero adds nothing. */
const post = (lines, account, paisa, label, party) => {
  if (!paisa) return;
  lines.push({
    account,
    ...(paisa > 0 ? { debitPaisa: paisa } : { creditPaisa: -paisa }),
    label,
    ...(party ? { party } : {})
  });
};

/** What a parcel holds before this receipt touches it — enough to put it back exactly. */
const snapshot = order => ({
  paymentStatus: order.paymentStatus ?? null,
  courierSettlement: order.courierSettlement ?? null,
  deliveryChargePaisa: order.deliveryChargePaisa ?? null,
  deliveryChargeEntry: order.deliveryChargeEntry ?? null,
  returnChargePaisa: order.returnChargePaisa ?? null,
  returnChargeEntry: order.returnChargeEntry ?? null,
  walletPaisa: order.courierBooking?.walletPaisa ?? null,
  settlementDate: order.courierBooking?.settlementDate ?? null,
  codSettledAt: order.courierBooking?.codSettledAt ?? null,
  walletChargeEntry: order.courierBooking?.walletChargeEntry ?? null,
  walletChargedAt: order.courierBooking?.walletChargedAt ?? null
});

const FIELD_OF = {
  paymentStatus: 'paymentStatus',
  courierSettlement: 'courierSettlement',
  deliveryChargePaisa: 'deliveryChargePaisa',
  deliveryChargeEntry: 'deliveryChargeEntry',
  returnChargePaisa: 'returnChargePaisa',
  returnChargeEntry: 'returnChargeEntry',
  walletPaisa: 'courierBooking.walletPaisa',
  settlementDate: 'courierBooking.settlementDate',
  codSettledAt: 'courierBooking.codSettledAt',
  walletChargeEntry: 'courierBooking.walletChargeEntry',
  walletChargedAt: 'courierBooking.walletChargedAt'
};

/** The update that puts a parcel back as `previous` says (a null means it had none). */
const restoreUpdate = previous => {
  const $set = {};
  const $unset = { 'courierBooking.cprNumber': '' };
  for (const [key, field] of Object.entries(FIELD_OF)) {
    if (previous?.[key] === null || previous?.[key] === undefined) $unset[field] = '';
    else $set[field] = previous[key];
  }
  return { $set, $unset };
};

const trackingsOf = order =>
  [order.courierBooking?.trackingNumber, order.trackingId]
    .map(v => String(v ?? '').trim())
    .filter(Boolean);

/**
 * Decide, for every parcel on the receipt, what happens. Reads only — nothing is posted or changed here. `wallet` may be
 * null when the courier has no wallet yet (a preview); the lines then name no account and are never posted.
 */
export const planReceipt = async ({ business, courier, receipt, wallet = null }) => {
  await ensureChart(business);
  const trackings = receipt.rows.map(r => r.tracking);

  const [orders, biz, existing, R, DC, RC] = await Promise.all([
    Order.find({
      business,
      courier: courier._id,
      $or: [
        { 'courierBooking.trackingNumber': { $in: trackings } },
        { trackingId: { $in: trackings } }
      ]
    }).lean(),
    Business.findById(business).select('name codTax').lean(),
    CourierReceipt.findOne({ business, courier: courier._id, cprNumber: receipt.cprNumber }).lean(),
    accountByCode(business, CODES.COD_RECEIVABLE),
    accountByCode(business, CODES.DELIVERY_CHARGES),
    accountByCode(business, CODES.RETURN_CHARGES)
  ]);

  // The sale entry of each order (what was booked at delivery) and the entry that paid it, if one did.
  const entryIds = [
    ...new Set(
      orders
        .flatMap(o => [o.saleEntry, o.courierSettlement])
        .filter(Boolean)
        .map(String)
    )
  ];
  const entries = entryIds.length ? await JournalEntry.find({ _id: { $in: entryIds } }).lean() : [];
  const entryById = new Map(entries.map(e => [String(e._id), e]));
  const touchesWallet = entry =>
    Boolean(wallet && entry?.lines.some(l => String(l.account) === String(wallet._id)));

  const ordersByTracking = new Map();
  for (const o of orders) {
    for (const t of trackingsOf(o)) {
      ordersByTracking.set(t, [...(ordersByTracking.get(t) ?? []), o]);
    }
  }
  const before = new Map((existing?.rows ?? []).map(r => [r.tracking, r]));
  const cprDate = parseBusinessDate(receipt.cprDate);

  const rows = receipt.rows.map(row => {
    const base = {
      tracking: row.tracking,
      status: row.status,
      codPaisa: row.codPaisa,
      shippingPaisa: row.shippingPaisa,
      gstPaisa: row.gstPaisa,
      deductionPaisa: row.deductionPaisa,
      netPaisa: row.netPaisa,
      lines: [],
      walletChangePaisa: 0,
      appPaisa: 0,
      alreadyPaisa: 0
    };
    const wait = reason => ({ ...base, outcome: 'pending', reason });

    if (before.get(row.tracking)?.outcome === 'applied') {
      const done = before.get(row.tracking);
      return { ...base, outcome: 'applied', before: true, case: done.case, order: done.order };
    }
    const found = [...new Set((ordersByTracking.get(row.tracking) ?? []).map(String))];
    const matches = (ordersByTracking.get(row.tracking) ?? []).filter(
      (o, i, all) => all.findIndex(x => String(x._id) === String(o._id)) === i
    );
    if (found.length === 0) return { ...base, outcome: 'ignored', reason: 'Not in B Ledger' };
    if (matches.length > 1)
      return wait('Two orders carry this tracking number — fix one of them in Orders');

    const [order] = matches;
    const withOrder = { ...base, order: order._id, orderNumber: order.orderNumber };
    const onReceipt = order.courierBooking?.cprNumber;
    if (onReceipt && onReceipt !== receipt.cprNumber) {
      return {
        ...withOrder,
        outcome: 'pending',
        reason: `Already settled on receipt ${onReceipt}`
      };
    }
    if (onReceipt === receipt.cprNumber) {
      return {
        ...withOrder,
        outcome: 'applied',
        before: true,
        case: 'already',
        reason: 'Already on this receipt'
      };
    }

    const label = `#${order.orderNumber} · ${row.tracking}`;
    const lines = [];
    let walletChange = 0;
    const toWallet = paisa => {
      walletChange += paisa;
      post(lines, wallet?._id ?? null, paisa, label);
    };
    const to = (account, paisa, party) => post(lines, account._id, paisa, label, party);
    const charge = row.shippingPaisa + row.gstPaisa;
    const previous = snapshot(order);
    const doneBase = { ...withOrder, previous, lines };
    const finish = (kind, extra) => ({
      ...doneBase,
      outcome: 'applied',
      case: kind,
      get walletChangePaisa() {
        return walletChange;
      },
      ...extra
    });
    const chargeAccount = row.status === 'delivered' ? DC : RC;
    const chargeField =
      row.status === 'delivered'
        ? { paisa: 'deliveryChargePaisa', entry: 'deliveryChargeEntry' }
        : { paisa: 'returnChargePaisa', entry: 'returnChargeEntry' };
    const onWallet = Boolean(order.courierBooking?.walletChargeEntry);
    const sets = (entryId, now, more = {}) => ({
      $set: {
        'courierBooking.cprNumber': receipt.cprNumber,
        ...(entryId
          ? { 'courierBooking.walletChargeEntry': entryId, 'courierBooking.walletChargedAt': now }
          : {}),
        ...more
      }
    });

    // ── a delivered parcel ────────────────────────────────────────────────────────────────────────
    if (row.status === 'delivered') {
      if (!DELIVERED_ONCE.includes(order.status)) {
        return wait(
          `B Ledger says ${order.status}. Mark it delivered in Orders, then add this receipt again.`
        );
      }

      if (row.codPaisa > 0) {
        if (order.paymentStatus === PAYMENT_STATUS.UNPAID) {
          const booked = netOwed(order, biz?.codTax, new Map(entries.map(e => [String(e._id), e])));
          toWallet(row.netPaisa);
          to(R, -booked, courier._id);
          to(DC, booked - row.netPaisa);
          return finish('paid', {
            appPaisa: booked,
            update: (entryId, now) => ({
              $set: {
                paymentStatus: PAYMENT_STATUS.PAID,
                courierSettlement: entryId,
                'courierBooking.cprNumber': receipt.cprNumber,
                'courierBooking.walletPaisa': row.netPaisa,
                'courierBooking.settlementDate': cprDate,
                'courierBooking.codSettledAt': now,
                ...(order.deliveryChargePaisa == null
                  ? { deliveryChargePaisa: charge, deliveryChargeEntry: entryId }
                  : {})
              }
            })
          });
        }
        const paidBy = entryById.get(String(order.courierSettlement));
        if (order.paymentStatus === PAYMENT_STATUS.PAID && touchesWallet(paidBy)) {
          const had =
            order.courierBooking?.walletPaisa ??
            netOwed(order, biz?.codTax, new Map(entries.map(e => [String(e._id), e])));
          toWallet(row.netPaisa - had);
          to(DC, -(row.netPaisa - had));
          return finish('topup', {
            appPaisa: had,
            alreadyPaisa: had,
            update: () => ({
              $set: {
                'courierBooking.cprNumber': receipt.cprNumber,
                'courierBooking.walletPaisa': row.netPaisa,
                'courierBooking.settlementDate': cprDate
              }
            })
          });
        }
        return wait(
          'Already recorded as paid by a courier invoice (into your bank, not the wallet). PostEx paid it into the wallet — undo that invoice from the journal, then add this receipt again.'
        );
      }
    } else if (order.status !== ORDER_STATUS.RETURNED) {
      return wait(
        `B Ledger says ${order.status}. Mark it returned in Orders, then add this receipt again.`
      );
    }

    // ── a charge: a returned parcel, or a delivered one with no cash to collect ─────────────────────
    const had = order[chargeField.paisa];
    if (had === null || had === undefined) {
      to(chargeAccount, charge);
      toWallet(-charge);
      return finish('charge', {
        appPaisa: 0,
        update: (entryId, now) =>
          sets(entryId, now, { [chargeField.paisa]: charge, [chargeField.entry]: entryId })
      });
    }
    if (!onWallet) {
      to(R, had, courier._id);
      toWallet(-had);
      to(chargeAccount, charge - had);
      toWallet(-(charge - had));
      return finish('moveCharge', {
        appPaisa: -had,
        update: (entryId, now) => sets(entryId, now, { [chargeField.paisa]: charge })
      });
    }
    to(chargeAccount, charge - had);
    toWallet(-(charge - had));
    return finish('chargeDiff', {
      appPaisa: -had,
      alreadyPaisa: -had,
      update: (entryId, now) => sets(null, now, { [chargeField.paisa]: charge })
    });
  });

  // Plain objects (the getter above is read once here).
  const settled = rows.map(r => ({ ...r, walletChangePaisa: r.walletChangePaisa }));
  const sum = (pick, list = settled) => list.reduce((s, r) => s + pick(r), 0);
  const willAdd = settled.filter(r => r.outcome === 'applied' && !r.before);
  const summary = {
    receiptNetPaisa: receipt.totals.netPaisa,
    ignoredNetPaisa: sum(
      r => r.netPaisa,
      settled.filter(r => r.outcome === 'ignored')
    ),
    pendingNetPaisa: sum(
      r => r.netPaisa,
      settled.filter(r => r.outcome === 'pending')
    ),
    addedBeforeNetPaisa: sum(
      r => r.netPaisa,
      settled.filter(r => r.before)
    ),
    alreadyInWalletPaisa: sum(r => r.alreadyPaisa, willAdd),
    willAddPaisa: sum(r => r.walletChangePaisa, willAdd),
    willAddCount: willAdd.length,
    pendingCount: settled.filter(r => r.outcome === 'pending').length,
    ignoredCount: settled.filter(r => r.outcome === 'ignored').length,
    addedBeforeCount: settled.filter(r => r.before).length
  };

  const warnings = [];
  const norm = text =>
    String(text ?? '')
      .trim()
      .toLowerCase();
  if (receipt.merchant && norm(receipt.merchant) !== norm(biz?.name)) {
    warnings.push(
      `PostEx's merchant name is "${receipt.merchant}", this business is "${biz?.name}" — check you chose the right business.`
    );
  }
  return { rows: settled, summary, warnings, existing, accounts: { R, DC, RC }, cprDate };
};

/** The wallet account if the courier has one — without making one (a preview must not change anything). */
const findWallet = (business, courier) => Account.findOne({ business, courier: courier._id });

const refuseUnrelated = (plan, biz) => {
  if (plan.rows.length && plan.rows.every(r => r.outcome === 'ignored')) {
    throw new ErrorResponse(
      `None of these parcels belong to ${biz} in B Ledger — check you chose the right business and courier.`,
      400
    );
  }
};

/** What adding the receipt would do. Posts nothing. */
export const previewReceipt = async ({ business, courier, receipt }) => {
  const [wallet, biz] = await Promise.all([
    findWallet(business, courier),
    Business.findById(business).select('name').lean()
  ]);
  const plan = await planReceipt({ business, courier, receipt, wallet });
  refuseUnrelated(plan, biz?.name ?? 'this business');
  return plan;
};

/**
 * Add the receipt to the courier's wallet: one journal entry for everything that can go on now, dated the receipt's
 * own date; every parcel tagged with the receipt number. Adding the same receipt again only finishes the parcels that
 * were waiting. Safe against two taps at once (a lock on the receipt, and each parcel is claimed before anything posts).
 */
export const importReceipt = async ({ business, courier, receipt, userId }) => {
  const biz = await Business.findById(business).select('name').lean();
  const wallet = await courierWalletFor(business, courier, userId);

  let doc = await CourierReceipt.findOne({
    business,
    courier: courier._id,
    cprNumber: receipt.cprNumber
  });
  if (!doc) {
    try {
      doc = await CourierReceipt.create({
        business,
        courier: courier._id,
        cprNumber: receipt.cprNumber,
        cprDate: parseBusinessDate(receipt.cprDate),
        merchant: receipt.merchant,
        totals: receipt.totals,
        importedBy: userId
      });
    } catch (err) {
      if (err?.code !== 11000) throw err;
      doc = await CourierReceipt.findOne({
        business,
        courier: courier._id,
        cprNumber: receipt.cprNumber
      });
    }
  }
  const locked = await CourierReceipt.findOneAndUpdate(
    {
      _id: doc._id,
      $or: [
        { applyingAt: { $exists: false } },
        { applyingAt: { $lt: new Date(Date.now() - LOCK_MS) } }
      ]
    },
    { $set: { applyingAt: new Date() } },
    { returnDocument: 'after' }
  );
  if (!locked)
    throw new ErrorResponse('This receipt is being added right now. Try again in a moment.', 409);

  let claimed = [];
  try {
    const plan = await planReceipt({ business, courier, receipt, wallet });
    refuseUnrelated(plan, biz?.name ?? 'this business');

    const now = new Date();
    // Claim each parcel first: a parcel changed since the plan, or on another receipt, is left out.
    const candidates = plan.rows.filter(r => r.outcome === 'applied' && !r.before);
    const results = await Promise.all(
      candidates.map(r =>
        Order.updateOne(
          { _id: r.order, 'courierBooking.cprNumber': { $exists: false } },
          { $set: { 'courierBooking.cprNumber': receipt.cprNumber } }
        )
      )
    );
    claimed = candidates.filter((_, i) => results[i].modifiedCount === 1);
    for (const r of candidates) {
      if (!claimed.includes(r)) {
        r.outcome = 'pending';
        r.reason = 'Changed while the receipt was being added — add it again';
        r.lines = [];
      }
    }

    const lines = claimed.flatMap(r => r.lines);
    let entry = null;
    if (lines.length) {
      entry = await postEntry({
        business,
        date: plan.cprDate,
        memo: `PostEx receipt ${receipt.cprNumber} — ${claimed.length} parcel${claimed.length === 1 ? '' : 's'}`,
        source: { kind: JOURNAL_SOURCES.COURIER_RECEIPT, ref: String(doc._id) },
        lines,
        userId
      });
    }
    await Promise.all(
      claimed.map(r => Order.updateOne({ _id: r.order }, r.update(entry?._id, now)))
    );

    const saved = plan.rows.map(r => ({
      tracking: r.tracking,
      status: r.status,
      codPaisa: r.codPaisa,
      shippingPaisa: r.shippingPaisa,
      gstPaisa: r.gstPaisa,
      deductionPaisa: r.deductionPaisa,
      netPaisa: r.netPaisa,
      order: r.order,
      outcome: r.outcome,
      case: r.case,
      reason: r.reason,
      entry: claimed.includes(r) ? entry?._id : undefined,
      previous: claimed.includes(r) ? r.previous : undefined
    }));
    // A parcel finished by an earlier run keeps its own entry and snapshot.
    const earlier = new Map(doc.rows.map(r => [r.tracking, r]));
    for (const r of saved) {
      const old = earlier.get(r.tracking);
      if (
        old?.outcome === 'applied' &&
        r.outcome === 'applied' &&
        !claimed.some(c => c.tracking === r.tracking)
      ) {
        Object.assign(r, { entry: old.entry, previous: old.previous, case: old.case });
      }
    }
    await CourierReceipt.updateOne(
      { _id: doc._id },
      {
        $set: { rows: saved, merchant: receipt.merchant, totals: receipt.totals },
        ...(entry ? { $push: { entries: entry._id } } : {})
      }
    );
    logger.info(
      { receipt: receipt.cprNumber, parcels: claimed.length, entry: entry && String(entry._id) },
      'postex receipt added to the courier wallet'
    );
    return { ...plan, entry };
  } catch (err) {
    // Nothing posted that matters: free the parcels this run claimed so the receipt can be added again.
    await Promise.all(
      claimed.map(r =>
        Order.updateOne(
          { _id: r.order, 'courierBooking.cprNumber': receipt.cprNumber },
          { $unset: { 'courierBooking.cprNumber': '' } }
        )
      )
    );
    throw err;
  } finally {
    await CourierReceipt.updateOne({ _id: doc._id }, { $unset: { applyingAt: '' } });
  }
};

/**
 * Called when an entry made from a receipt is reversed in the journal: every parcel that entry settled goes back to
 * exactly what it was, and its row waits again — so the receipt can be added again after the cause is fixed.
 */
export const undoCourierReceipt = async entryId => {
  const doc = await CourierReceipt.findOne({ entries: entryId });
  if (!doc) return;
  const rows = doc.rows.filter(r => String(r.entry) === String(entryId));
  await Promise.all(
    rows.filter(r => r.order).map(r => Order.updateOne({ _id: r.order }, restoreUpdate(r.previous)))
  );
  for (const r of rows) {
    r.outcome = 'pending';
    r.reason = 'Undone — add the receipt again to put it back';
    r.entry = undefined;
    r.previous = undefined;
  }
  doc.entries = doc.entries.filter(e => String(e) !== String(entryId));
  doc.markModified('rows');
  await doc.save();
};

/** The receipts already added for a courier, newest first, with how many parcels are on, waiting and ignored. */
export const listReceipts = async ({ business, courier }) => {
  const docs = await CourierReceipt.find({ business, courier })
    .sort({ cprDate: -1 })
    .select('-rows.previous')
    .lean();
  return docs.map(d => ({
    _id: d._id,
    cprNumber: d.cprNumber,
    cprDate: d.cprDate,
    merchant: d.merchant,
    totals: d.totals,
    counts: {
      applied: d.rows.filter(r => r.outcome === 'applied').length,
      pending: d.rows.filter(r => r.outcome === 'pending').length,
      ignored: d.rows.filter(r => r.outcome === 'ignored').length
    },
    addedAt: d.createdAt
  }));
};
