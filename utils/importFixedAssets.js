import Account from '../models/Account.js';
import FixedAsset from '../models/FixedAsset.js';
import JournalEntry from '../models/JournalEntry.js';
import { accountBalance } from './ledger.js';
import { assetNameFor } from './fixedAssets.js';
import { CODES } from './chartOfAccounts.js';
import { JOURNAL_SOURCES } from './constants.js';

/**
 * ONE-OFF (Round 16). Before the asset list existed, buying an asset was just an entry. This lists every one of those
 * purchases that is not reversed and not listed yet — named from its memo, at what it cost, on the day it was bought —
 * so it can be sold or thrown away like the new ones. It also reports the depreciation ever posted per business, so an
 * accountant can say how much of it belongs to an item when it is sold.
 *
 * `apply: false` (the default) only counts. Safe to run twice: a listed purchase is skipped the second time.
 * If a business's hand-entered money is about to be cleared, clear FIRST and import after, or the cleared assets come back.
 */
export const importFixedAssets = async ({ apply = false } = {}) => {
  const accounts = await Account.find({ code: CODES.FIXED_ASSETS }).select('_id business').lean();
  const assetAccountOf = new Map(accounts.map(a => [String(a.business), String(a._id)]));
  const entries = await JournalEntry.find({
    business: { $in: accounts.map(a => a.business) },
    'source.kind': JOURNAL_SOURCES.ASSET,
    reversalOf: { $exists: false }
  })
    .sort({ date: 1 })
    .lean();

  const reversed = new Set(
    (
      await JournalEntry.find({ reversalOf: { $in: entries.map(e => e._id) } })
        .select('reversalOf')
        .lean()
    ).map(r => String(r.reversalOf))
  );
  const listed = new Set(
    (
      await FixedAsset.find({ purchaseEntry: { $in: entries.map(e => e._id) } })
        .select('purchaseEntry')
        .lean()
    ).map(a => String(a.purchaseEntry))
  );

  const byBusiness = new Map();
  for (const entry of entries) {
    if (reversed.has(String(entry._id)) || listed.has(String(entry._id))) continue;
    const mine = assetAccountOf.get(String(entry.business));
    const costPaisa = entry.lines
      .filter(l => String(l.account) === mine)
      .reduce((sum, l) => sum + (l.debitPaisa || 0), 0);
    if (!(costPaisa > 0)) continue;
    const row = byBusiness.get(String(entry.business)) ?? {
      business: String(entry.business),
      count: 0,
      costPaisa: 0
    };
    row.count += 1;
    row.costPaisa += costPaisa;
    byBusiness.set(String(entry.business), row);
    if (apply) {
      await FixedAsset.create({
        business: entry.business,
        name: assetNameFor({ memo: entry.memo, date: entry.date }),
        costPaisa,
        boughtOn: entry.date,
        purchaseEntry: entry._id,
        note: 'Listed from an earlier purchase',
        createdBy: entry.createdBy
      });
    }
  }

  const businesses = [];
  for (const row of byBusiness.values()) {
    const accumulated = await Account.findOne({
      business: row.business,
      code: CODES.ACCUMULATED_DEPRECIATION
    })
      .select('_id')
      .lean();
    // Accumulated Depreciation is a contra-asset: what was posted to it shows as a credit (negative) balance.
    const depreciationPaisa = accumulated
      ? Math.max(0, -(await accountBalance(row.business, accumulated._id)))
      : 0;
    businesses.push({ ...row, depreciationPaisa });
  }
  return { businesses, assets: businesses.reduce((n, b) => n + b.count, 0) };
};
