import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import Account from '../models/Account.js';
import JournalEntry from '../models/JournalEntry.js';
import Party from '../models/Party.js';
import PeriodLock from '../models/PeriodLock.js';
import ErrorResponse from './errorResponse.js';
import { snapshotDir } from './businessData.js';
import logger from './logger.js';
import { JOURNAL_SOURCES, PARTY_TYPES } from './constants.js';

/**
 * Clearing the ledger WITHOUT touching the business's orders. Every money entry has two sides, so deleting an
 * order's sale but keeping its payment would leave the books wrong — instead only the entries a PERSON typed are
 * deleted, and everything the system posts itself (sales, advances, refunds, courier invoices, PostEx receipts,
 * goods, materials, production, consignments) stays. Data-entry mistakes live in the first group; the second must stay
 * for refunds, exchanges, courier invoices and receipt undo to keep working (they read the order's own entries).
 *
 * Kept even though hand-typed, because the owner asked for them to survive:
 *   • a transfer that touches a courier wallet (a PostEx withdrawal) — the wallet balance must not change;
 *   • a payment tagged to a customer's khata — customer payments are kept.
 */
export const HAND_KINDS = [
  JOURNAL_SOURCES.MANUAL,
  JOURNAL_SOURCES.CAPITAL,
  JOURNAL_SOURCES.EXPENSE,
  JOURNAL_SOURCES.PAYMENT,
  JOURNAL_SOURCES.SALARY,
  JOURNAL_SOURCES.TRANSFER,
  JOURNAL_SOURCES.OPENING,
  JOURNAL_SOURCES.ASSET,
  JOURNAL_SOURCES.LOAN,
  JOURNAL_SOURCES.DEPRECIATION,
  JOURNAL_SOURCES.CLOSING
];

/** Plain words for the screen — keyed by `source.kind`. */
export const KIND_WORDS = {
  [JOURNAL_SOURCES.MANUAL]: 'accountant entries',
  [JOURNAL_SOURCES.CAPITAL]: 'money put in or owner withdrawals',
  [JOURNAL_SOURCES.EXPENSE]: 'expenses',
  [JOURNAL_SOURCES.PAYMENT]: 'payments',
  [JOURNAL_SOURCES.SALARY]: 'salaries',
  [JOURNAL_SOURCES.TRANSFER]: 'money moved between places',
  [JOURNAL_SOURCES.OPENING]: 'opening balances',
  [JOURNAL_SOURCES.ASSET]: 'assets bought',
  [JOURNAL_SOURCES.LOAN]: 'loans',
  [JOURNAL_SOURCES.DEPRECIATION]: 'depreciation',
  [JOURNAL_SOURCES.CLOSING]: 'year-end closings'
};

const idOf = value => String(value);

/** Which entries a clear would delete, and why the rest stay. Reads only. */
const selectEntries = async business => {
  const [entries, wallets, customers] = await Promise.all([
    JournalEntry.find({ business, 'source.kind': { $in: HAND_KINDS } })
      .select('source lines reversalOf')
      .lean(),
    Account.find({ business, heldByCourier: true }).select('_id').lean(),
    Party.find({ business, type: PARTY_TYPES.CUSTOMER }).select('_id').lean()
  ]);
  const walletIds = new Set(wallets.map(a => idOf(a._id)));
  const customerIds = new Set(customers.map(p => idOf(p._id)));

  const isKept = entry => {
    const kind = entry.source?.kind;
    if (
      kind === JOURNAL_SOURCES.TRANSFER &&
      entry.lines.some(l => walletIds.has(idOf(l.account)))
    ) {
      return true;
    }
    return (
      kind === JOURNAL_SOURCES.PAYMENT &&
      entry.lines.some(l => l.party && customerIds.has(idOf(l.party)))
    );
  };
  const selected = entries.filter(e => !isKept(e));

  // A reversal carries its original's kind and mirrored lines, so the two are always kept or cleared together. If
  // that ever stopped being true, refuse rather than leave half a pair — the books would not net to zero.
  const ids = new Set(selected.map(e => idOf(e._id)));
  for (const e of selected) {
    if (e.reversalOf && !ids.has(idOf(e.reversalOf))) {
      throw new ErrorResponse(
        'An entry and its reversal would be split — nothing was cleared',
        500
      );
    }
  }
  for (const e of entries) {
    if (isKept(e) && e.reversalOf && ids.has(idOf(e.reversalOf))) {
      throw new ErrorResponse(
        'An entry and its reversal would be split — nothing was cleared',
        500
      );
    }
  }
  return selected;
};

/** Net debit (paisa) per account and per khata person, over every entry except `excluded`. */
const balances = async (business, excluded) => {
  const match = {
    business: new mongoose.Types.ObjectId(idOf(business)),
    ...(excluded.length ? { _id: { $nin: excluded } } : {})
  };
  const group = key => [
    { $match: match },
    { $unwind: '$lines' },
    ...(key === 'party' ? [{ $match: { 'lines.party': { $exists: true, $ne: null } } }] : []),
    {
      $group: {
        _id: key === 'party' ? '$lines.party' : '$lines.account',
        net: { $sum: { $subtract: ['$lines.debitPaisa', '$lines.creditPaisa'] } }
      }
    }
  ];
  const [byAccount, byParty] = await Promise.all([
    JournalEntry.aggregate(group('account')),
    JournalEntry.aggregate(group('party'))
  ]);
  return {
    account: new Map(byAccount.map(r => [idOf(r._id), r.net])),
    party: new Map(byParty.map(r => [idOf(r._id), r.net]))
  };
};

/**
 * What a clear would do: how many entries of each kind go, how many period locks, and every money account's and khata
 * person's balance now → after — so the owner knows exactly what to re-enter.
 */
export const planLedgerClear = async business => {
  const selected = await selectEntries(business);
  const ids = selected.map(e => e._id);
  const [now, after, accounts, parties, periodLocks] = await Promise.all([
    balances(business, []),
    balances(business, ids),
    Account.find({ business, $or: [{ moneyKind: { $exists: true } }, { heldByCourier: true }] })
      .select('name moneyKind heldByCourier')
      .lean(),
    Party.find({ business }).select('name type').lean(),
    PeriodLock.countDocuments({ business })
  ]);

  const countsByKind = {};
  for (const e of selected) {
    countsByKind[e.source.kind] = (countsByKind[e.source.kind] ?? 0) + 1;
  }
  const row = (kind, doc, map, afterMap) => ({
    kind,
    id: idOf(doc._id),
    name: doc.name,
    nowPaisa: map.get(idOf(doc._id)) ?? 0,
    afterPaisa: afterMap.get(idOf(doc._id)) ?? 0
  });
  const changed = r => r.nowPaisa !== r.afterPaisa;
  return {
    ids,
    count: selected.length,
    countsByKind,
    periodLocks,
    balances: [
      ...accounts.map(a => row('money', a, now.account, after.account)),
      ...parties.map(p => ({ ...row('party', p, now.party, after.party), partyType: p.type }))
    ].filter(changed)
  };
};

/**
 * Write exactly what is about to be deleted to one JSON-lines file, so a wrong click can be rebuilt for this business
 * alone. Throws on any failure — the clear must not go ahead without its safety copy.
 */
const snapshotLedger = async (business, ids) => {
  const dir = snapshotDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${idOf(business)}-ledger-${stamp}.jsonl`);
  const out = fs.createWriteStream(file);
  const write = line =>
    new Promise((resolve, reject) => out.write(line, err => (err ? reject(err) : resolve())));
  for await (const doc of JournalEntry.find({ _id: { $in: ids } })
    .lean()
    .cursor()) {
    await write(`${JSON.stringify({ collection: 'journalentries', doc })}\n`);
  }
  for await (const doc of PeriodLock.find({ business }).lean().cursor()) {
    await write(`${JSON.stringify({ collection: 'periodlocks', doc })}\n`);
  }
  await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));
  return file;
};

/**
 * Delete the hand-entered money entries and the period locks of ONE business, after writing the safety copy. Re-plans
 * here — a client's plan is never trusted. Returns what went and the balances that are left.
 */
export const clearLedger = async ({ business, userId }) => {
  const plan = await planLedgerClear(business);
  const snapshot = await snapshotLedger(business, plan.ids);

  const { deletedCount } = await JournalEntry.deleteMany({ business, _id: { $in: plan.ids } });
  const locks = await PeriodLock.deleteMany({ business });

  logger.warn(
    {
      userId: String(userId),
      business: String(business),
      cleared: plan.countsByKind,
      entries: deletedCount,
      periodLocks: locks.deletedCount,
      snapshot
    },
    'ledger cleared'
  );
  return {
    deleted: deletedCount,
    countsByKind: plan.countsByKind,
    periodLocks: locks.deletedCount,
    balances: plan.balances
  };
};
