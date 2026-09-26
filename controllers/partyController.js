import Party from '../models/Party.js';
import JournalEntry from '../models/JournalEntry.js';
import Order from '../models/Order.js';
import Business from '../models/Business.js';
import asyncHandler from '../middlewares/asyncHandler.js';
import ErrorResponse from '../utils/errorResponse.js';
import { createCrudHandlers } from '../utils/crudController.js';
import { partyBalancesByIds, partyStatement, postEntry } from '../utils/ledger.js';
import { ensureChart } from '../utils/chartOfAccounts.js';
import { partyLedgerReport } from '../utils/reports.js';
import { partyTransactionLines, allocateCustomerPayment } from '../utils/partyPosting.js';
import { settleCourier } from '../utils/courierSettlement.js';
import { computeRemittance } from '../utils/orderPosting.js';
import { fromPaisa, toPaisa } from '../utils/money.js';
import { JOURNAL_SOURCES, PARTY_TYPES } from '../utils/constants.js';

/**
 * Attach each order-sourced statement row's own breakdown, so a courier or
 * customer statement shows *what made up* the credit/debit — not just the net.
 * A courier row unpacks the COD: total, advance, delivery + FBR taxes withheld,
 * and the net receivable. A walk-in customer row is simpler: total, advance and
 * the balance left on credit. Non-order rows (a supplier's production costs) are
 * untouched. Orders are fetched once for the whole page.
 */
const enrichOrderRows = async (business, rows) => {
  const refs = [
    ...new Set(
      rows.filter(r => r.source?.kind === JOURNAL_SOURCES.ORDER).map(r => String(r.source.ref))
    )
  ];
  if (!refs.length) return;

  const orders = await Order.find({ _id: { $in: refs } }).select(
    'orderNumber trackingId total advanceAmount codAmount deliveryChargePaisa courier saleEntry paymentEntry'
  );
  const byId = new Map(orders.map(o => [String(o._id), o]));
  const biz = await Business.findById(business).select('codTax');

  for (const row of rows) {
    if (row.source?.kind !== JOURNAL_SOURCES.ORDER) continue;
    const o = byId.get(String(row.source.ref));
    if (!o) continue;

    if (o.courier) {
      // The COD breakdown explains the sale and its remittance only. A return
      // charge, pickup charge or reversal on the same order is its own row —
      // attaching the COD to it would misread as money the courier owes.
      const isCodRow = [o.saleEntry, o.paymentEntry].some(
        e => e && String(e) === String(row.entry)
      );
      if (!isCodRow) continue;
      const parts = computeRemittance(
        toPaisa(o.codAmount),
        o.deliveryChargePaisa || 0,
        biz?.codTax || {}
      );
      row.order = {
        counterSale: false,
        orderNumber: o.orderNumber,
        trackingId: o.trackingId || null,
        total: o.total,
        advance: o.advanceAmount || 0,
        codAmount: o.codAmount,
        deliveryCharge: fromPaisa(parts.deliveryPaisa),
        withholdingTax: fromPaisa(parts.whtPaisa),
        salesTax: fromPaisa(parts.salesTaxPaisa),
        netReceivable: fromPaisa(parts.bankPaisa)
      };
    } else {
      row.order = {
        counterSale: true,
        orderNumber: o.orderNumber,
        total: o.total,
        advance: o.advanceAmount || 0,
        // The balance left on credit after whatever was paid at the counter.
        remaining: o.codAmount
      };
    }
  }
};

/**
 * Parties — suppliers, resellers, employees, couriers. Standard CRUD, except a
 * party with any ledger history can't be hard-deleted (it would orphan journal
 * lines) — deactivate instead. Balances are derived, never stored.
 *
 * @route  GET/POST         /api/v1/parties        (parties:read / :create)
 * @route  GET/PUT/DELETE   /api/v1/parties/:id    (parties:read / :update / :delete)
 * @route  GET             /api/v1/parties/:id/statement  (parties:read)
 */
const handlers = createCrudHandlers({
  model: Party,
  beforeDelete: async doc => {
    const used = await JournalEntry.countDocuments({ 'lines.party': doc._id });
    if (used > 0) {
      return new ErrorResponse(
        `Cannot delete — this party has ${used} ledger entr${used === 1 ? 'y' : 'ies'}. Deactivate them instead.`,
        400
      );
    }
    return null;
  }
});

export const {
  getOne: getParty,
  create: createParty,
  update: updateParty,
  remove: deleteParty
} = handlers;

/**
 * @desc   List parties with each one's running balance merged in
 * @route  GET /api/v1/parties  (parties:read — scoped)
 */
export const getParties = asyncHandler(async (req, res) => {
  const result = res.advancedResults;
  const ids = result.data.map(p => p._id);
  const balances = await partyBalancesByIds(ids);

  result.data = result.data.map(party => {
    const paisa = balances[String(party._id)] || 0;
    return { ...party.toObject(), balance: fromPaisa(paisa), balancePaisa: paisa };
  });

  res.status(200).json(result);
});

/**
 * @desc   A party's full statement — every line touching them, running balance
 * @route  GET /api/v1/parties/:id/statement  (parties:read — scoped)
 */
export const getPartyStatement = asyncHandler(async (req, res) => {
  // loadScoped set req.resource, so scope (404-not-403) is already enforced.
  const party = req.resource;
  const { rows, balancePaisa } = await partyStatement(party.business, party._id);
  await enrichOrderRows(party.business, rows);

  res.status(200).json({
    success: true,
    data: {
      party,
      balance: fromPaisa(balancePaisa),
      balancePaisa,
      rows: rows.map(r => ({
        ...r,
        debit: fromPaisa(r.debitPaisa),
        credit: fromPaisa(r.creditPaisa),
        balance: fromPaisa(r.balancePaisa)
      }))
    }
  });
});

/**
 * @desc   Totals across every party of a business — what is owed to you and what
 *         you owe — for the top of the parties list. Computed over ALL parties,
 *         not the page on screen, so the numbers don't change as you scroll.
 * @route  GET /api/v1/parties/summary?business=  (parties:read — scoped)
 */
export const getPartySummary = asyncHandler(async (req, res, next) => {
  const { business } = req.query;
  if (!business) return next(new ErrorResponse('Choose a business', 400));
  const allowed = req.accessFilter?.business?.$in;
  if (allowed && !allowed.map(String).includes(String(business))) {
    // Out of scope reads as not found, never as forbidden (CLAUDE.md §6).
    return next(new ErrorResponse('Business not found', 404));
  }

  const { receivablePaisa, payablePaisa } = await partyLedgerReport(business);
  res.status(200).json({
    success: true,
    data: {
      receivable: fromPaisa(receivablePaisa),
      payable: fromPaisa(payablePaisa),
      receivablePaisa,
      payablePaisa
    }
  });
});

/**
 * @desc   "You gave" / "You got" on a party — DigiKhata's one action, on top of
 *         the double-entry books. The party's type picks the account (see
 *         `partyTransactionLines`), so the user never chooses one. A credit
 *         customer's payment is also applied to their unpaid counter sales; a
 *         courier's payment settles its delivered orders (`settleCourier`).
 * @route  POST /api/v1/parties/:id/transactions  (journal:create — scoped)
 */
export const recordPartyTransaction = asyncHandler(async (req, res, next) => {
  const party = req.resource;
  const { direction, method, category, date, memo } = req.body;
  const paisa = toPaisa(req.body.amount);

  // A courier pays in one weekly lump sum; that settles its orders, oldest
  // first. We never hand a courier money from here, so "gave" is refused.
  if (party.type === PARTY_TYPES.COURIER) {
    if (direction !== 'got') {
      return next(
        new ErrorResponse('A courier only pays you — record its payment with You got', 400)
      );
    }
    const { entry, settledOrders, unpaidOrders } = await settleCourier(party, paisa, {
      method,
      date,
      memo,
      userId: req.user.id
    });
    return res
      .status(201)
      .json({ success: true, data: { ...entry.toObject(), settledOrders, unpaidOrders } });
  }

  await ensureChart(party.business);
  const built = await partyTransactionLines(party, direction, paisa, { method, category });

  const entry = await postEntry({
    business: party.business,
    date,
    memo: memo || built.memo,
    source: { kind: built.source },
    lines: built.lines,
    userId: req.user.id
  });

  if (party.type === PARTY_TYPES.CUSTOMER && direction === 'got') {
    await allocateCustomerPayment(party.business, party._id, paisa);
  }

  res.status(201).json({ success: true, data: entry });
});
