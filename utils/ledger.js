import mongoose from 'mongoose';
import JournalEntry from '../models/JournalEntry.js';
import PeriodLock from '../models/PeriodLock.js';
import ErrorResponse from './errorResponse.js';

const toId = value => new mongoose.Types.ObjectId(value);

/** The latest lock date for a business, or null. */
export const latestLock = async business => {
  const lock = await PeriodLock.findOne({ business }).sort({ periodEnd: -1 });
  return lock ? lock.periodEnd : null;
};

/** Reject posting into a closed period — keeps reported history immutable. */
const assertNotLocked = async (business, when) => {
  const lockedThrough = await latestLock(business);
  if (lockedThrough && new Date(when) <= lockedThrough) {
    throw new ErrorResponse(
      `The books are locked through ${lockedThrough.toISOString().slice(0, 10)} — a later date is needed.`,
      400
    );
  }
};

/**
 * The one place a journal entry is written. Both sides are in `lines`, so this
 * is a single atomic document write. `lines` are `{ account, party?, product?,
 * batch?, debitPaisa?, creditPaisa? }`; the model's pre-validate hook enforces
 * that they balance.
 */
export const postEntry = async ({ business, date, memo, source, lines, userId }) => {
  const when = date || new Date();
  await assertNotLocked(business, when);

  return JournalEntry.create({
    business,
    date: when,
    memo,
    source: source || { kind: 'manual' },
    lines,
    createdBy: userId
  });
};

/**
 * Correct a mistake the honest way — post a mirror entry rather than editing
 * history. Debits become credits and vice-versa, so the pair nets to zero.
 */
export const reverseEntry = async (entryId, { userId, memo } = {}) => {
  const original = await JournalEntry.findById(entryId);
  if (!original) throw new ErrorResponse('Journal entry not found', 404);

  const lines = original.lines.map(line => ({
    account: line.account,
    party: line.party,
    product: line.product,
    batch: line.batch,
    // Carry the line-level label so a reversed order/consignment line still reads
    // "Order #… · tracking" on a party statement, not the generic entry memo.
    label: line.label,
    debitPaisa: line.creditPaisa,
    creditPaisa: line.debitPaisa
  }));

  return JournalEntry.create({
    business: original.business,
    date: new Date(),
    memo: memo || `Reversal of entry ${original._id}`,
    source: original.source,
    reversalOf: original._id,
    lines,
    createdBy: userId
  });
};

/**
 * Net movement (debit − credit, in paisa) across the lines matching a filter.
 * `lineMatch` filters the unwound line (e.g. by account or party); `entryMatch`
 * filters the entry (business, date range). Positive = net debit.
 */
const netPaisa = async (entryMatch, lineMatch) => {
  const rows = await JournalEntry.aggregate([
    { $match: entryMatch },
    { $unwind: '$lines' },
    { $match: lineMatch },
    {
      $group: {
        _id: null,
        debit: { $sum: '$lines.debitPaisa' },
        credit: { $sum: '$lines.creditPaisa' }
      }
    }
  ]);
  const row = rows[0] || { debit: 0, credit: 0 };
  return row.debit - row.credit;
};

/** Signed balance of one account (net debit, paisa). */
export const accountBalance = async (business, accountId, { asOf } = {}) => {
  const entryMatch = { business: toId(business) };
  if (asOf) entryMatch.date = { $lte: asOf };
  return netPaisa(entryMatch, { 'lines.account': toId(accountId) });
};

/**
 * Signed balance of one party (paisa). Positive = they owe us (a receivable);
 * negative = we owe them (a payable). This is the "against his name" number.
 */
export const partyBalance = async (business, partyId) => {
  return netPaisa({ business: toId(business) }, { 'lines.party': toId(partyId) });
};

/**
 * Net balances for many parties at once → `{ [partyId]: paisa }`. Keyed purely
 * by party id (each is unique to one business), so a list controller can pass
 * the ids on the current page and merge the result.
 */
export const partyBalancesByIds = async partyIds => {
  if (!partyIds.length) return {};
  const ids = partyIds.map(toId);
  const rows = await JournalEntry.aggregate([
    { $match: { 'lines.party': { $in: ids } } },
    { $unwind: '$lines' },
    { $match: { 'lines.party': { $in: ids } } },
    {
      $group: {
        _id: '$lines.party',
        debit: { $sum: '$lines.debitPaisa' },
        credit: { $sum: '$lines.creditPaisa' }
      }
    }
  ]);
  const map = {};
  for (const r of rows) map[String(r._id)] = r.debit - r.credit;
  return map;
};

/**
 * A subsidiary-ledger statement: every line tagged with a given dimension value,
 * oldest first, with a running balance. `dimension` is a fixed line field name
 * ('party' or 'account'), so this one builder serves the "against his name" party
 * screen and the per-account statement (a partner's capital account) alike.
 */
export const subledgerStatement = async (business, dimension, id) => {
  const entries = await JournalEntry.find({
    business: toId(business),
    [`lines.${dimension}`]: toId(id)
  })
    .sort({ date: 1, createdAt: 1 })
    .lean();

  let running = 0;
  const rows = [];
  for (const entry of entries) {
    for (const line of entry.lines) {
      if (String(line[dimension]) !== String(id)) continue;
      running += (line.debitPaisa || 0) - (line.creditPaisa || 0);
      rows.push({
        entry: entry._id,
        date: entry.date,
        // A line-level label (an order # + tracking id on COD lines) is more
        // specific than the entry memo — prefer it when present.
        memo: line.label || entry.memo,
        // What posted this line — lets a caller enrich order-sourced rows with
        // the order's own breakdown (total, advance, taxes) without re-parsing.
        source: entry.source,
        debitPaisa: line.debitPaisa || 0,
        creditPaisa: line.creditPaisa || 0,
        balancePaisa: running
      });
    }
  }
  return { rows, balancePaisa: running };
};

/** A party's statement — the subsidiary ledger on the `party` dimension. Serves
 *  every party type, couriers included (their COD is tagged to the party). */
export const partyStatement = (business, partyId) => subledgerStatement(business, 'party', partyId);

/**
 * Trial balance — every account's net, grouped by account. The sum of all nets
 * MUST be zero; a non-zero total means something posted wrong. Doubles as the
 * module's continuous integrity check.
 */
export const trialBalance = async (business, { from, to } = {}) => {
  const entryMatch = { business: toId(business) };
  if (from || to) {
    entryMatch.date = {};
    if (from) entryMatch.date.$gte = from;
    if (to) entryMatch.date.$lte = to;
  }

  const rows = await JournalEntry.aggregate([
    { $match: entryMatch },
    { $unwind: '$lines' },
    {
      $group: {
        _id: '$lines.account',
        debit: { $sum: '$lines.debitPaisa' },
        credit: { $sum: '$lines.creditPaisa' }
      }
    },
    {
      $lookup: { from: 'accounts', localField: '_id', foreignField: '_id', as: 'account' }
    },
    { $unwind: '$account' },
    { $sort: { 'account.code': 1 } },
    {
      $project: {
        _id: 0,
        account: '$account._id',
        code: '$account.code',
        name: '$account.name',
        type: '$account.type',
        netPaisa: { $subtract: ['$debit', '$credit'] }
      }
    }
  ]);

  const totalPaisa = rows.reduce((sum, r) => sum + r.netPaisa, 0);
  return { rows, totalPaisa, balanced: totalPaisa === 0 };
};
