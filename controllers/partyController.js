import Party from '../models/Party.js';
import JournalEntry from '../models/JournalEntry.js';
import Order from '../models/Order.js';
import Business from '../models/Business.js';
import asyncHandler from '../middlewares/asyncHandler.js';
import ErrorResponse from '../utils/errorResponse.js';
import { createCrudHandlers } from '../utils/crudController.js';
import { partyBalancesByIds, partyStatement } from '../utils/ledger.js';
import { computeRemittance } from '../utils/orderPosting.js';
import { fromPaisa, toPaisa } from '../utils/money.js';
import { JOURNAL_SOURCES } from '../utils/constants.js';

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
    'orderNumber trackingId total advanceAmount codAmount deliveryChargePaisa courier'
  );
  const byId = new Map(orders.map(o => [String(o._id), o]));
  const biz = await Business.findById(business).select('codTax');

  for (const row of rows) {
    if (row.source?.kind !== JOURNAL_SOURCES.ORDER) continue;
    const o = byId.get(String(row.source.ref));
    if (!o) continue;

    if (o.courier) {
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
