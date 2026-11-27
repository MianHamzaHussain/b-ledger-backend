import FixedAsset from '../models/FixedAsset.js';
import JournalEntry from '../models/JournalEntry.js';
import ErrorResponse from './errorResponse.js';
import { accountByCode, ensureChart, CODES } from './chartOfAccounts.js';
import { postEntry, reverseEntry } from './ledger.js';
import { pakistanDay } from './pakistanDay.js';
import { fromPaisa } from './money.js';
import { ASSET_STATUS, JOURNAL_SOURCES } from './constants.js';

/**
 * Fixed assets — things bought to keep and use. Buying one posts Dr Fixed Assets / Cr money (or a supplier) and makes
 * a `FixedAsset` row, so the app knows WHICH item it was and what it cost. Selling or throwing one away then books the
 * gain or loss by itself:
 *
 *   sold for `price`, book value = cost − depreciation counted for this item
 *     Dr money            price                      (when it was sold for something)
 *     Dr Accumulated Dep. depreciation               (when an accountant counted some for it)
 *     Cr Fixed Assets     cost
 *     Dr Loss on selling  book − price               (sold below book value: a loss to the business)
 *     Cr Gain on selling  price − book               (sold above it: extra profit)
 *
 * Bought 2,800, sold 2,500 → a Rs 300 loss. Thrown away is the same with a price of 0: the whole book value is a loss.
 * Only the latest action on an asset can be undone, and only from the asset (the journal refuses — see `assetEntryGuard`).
 */

/** What an asset bought with only a memo (older purchases, an older app) is called. */
export const assetNameFor = ({ name, memo, date }) => {
  const given = String(name || '').trim();
  if (given) return given;
  const note = String(memo || '').trim();
  if (note && note !== 'Fixed asset purchase') return note.slice(0, 80);
  return `Asset bought ${pakistanDay(date ? new Date(date) : new Date())}`;
};

/** Buy an asset: post the purchase, then list it. If listing fails the purchase is undone — never one without the other. */
export const buyAsset = async ({ business, name, note, costPaisa, credit, date, userId }) => {
  await ensureChart(business);
  const assetAccount = await accountByCode(business, CODES.FIXED_ASSETS);
  const entry = await postEntry({
    business,
    date,
    memo: `Fixed asset — ${name}`,
    source: { kind: JOURNAL_SOURCES.ASSET },
    lines: [{ account: assetAccount._id, debitPaisa: costPaisa }, credit],
    userId
  });
  try {
    const asset = await FixedAsset.create({
      business,
      name,
      costPaisa,
      boughtOn: entry.date,
      purchaseEntry: entry._id,
      note: note || undefined,
      createdBy: userId
    });
    return { asset, entry };
  } catch (err) {
    await reverseEntry(entry._id, { userId, memo: 'Asset could not be listed — purchase undone' });
    throw err;
  }
};

/**
 * Sell an asset, or throw it away (`throwAway`: no price, no money). Claims the asset first with one conditional
 * update (so two taps can not both sell it), then posts; if posting fails the claim is released.
 */
export const sellAsset = async (
  asset,
  { pricePaisa = 0, money, date, buyerName, depreciationPaisa, throwAway = false, userId }
) => {
  if (asset.status !== ASSET_STATUS.IN_USE) {
    throw new ErrorResponse('This asset has already been sold or thrown away', 400);
  }
  const when = date ? new Date(date) : new Date();
  if (pakistanDay(when) < pakistanDay(asset.boughtOn)) {
    throw new ErrorResponse(
      `It can not be sold before the day it was bought (${pakistanDay(asset.boughtOn)})`,
      400
    );
  }
  const price = throwAway ? 0 : pricePaisa;
  if (price > 0 && !money) throw new ErrorResponse('Choose where the money came in', 400);

  const depreciation = depreciationPaisa ?? asset.depreciationPaisa ?? 0;
  if (depreciation > asset.costPaisa) {
    throw new ErrorResponse('The depreciation can not be more than what it cost', 400);
  }
  const bookPaisa = asset.costPaisa - depreciation;
  const gainLossPaisa = price - bookPaisa;
  const target = throwAway ? ASSET_STATUS.THROWN_AWAY : ASSET_STATUS.SOLD;

  const claimed = await FixedAsset.findOneAndUpdate(
    { _id: asset._id, business: asset.business, status: ASSET_STATUS.IN_USE },
    { $set: { status: target } },
    { new: true }
  );
  if (!claimed) throw new ErrorResponse('This asset has already been sold or thrown away', 400);

  try {
    await ensureChart(asset.business);
    const [fixed, accumulated, gain, loss] = await Promise.all([
      accountByCode(asset.business, CODES.FIXED_ASSETS),
      accountByCode(asset.business, CODES.ACCUMULATED_DEPRECIATION),
      accountByCode(asset.business, CODES.ASSET_SALE_GAIN),
      accountByCode(asset.business, CODES.ASSET_SALE_LOSS)
    ]);
    const lines = [
      ...(price > 0 ? [{ account: money.account, debitPaisa: price }] : []),
      ...(depreciation > 0 ? [{ account: accumulated._id, debitPaisa: depreciation }] : []),
      { account: fixed._id, creditPaisa: asset.costPaisa },
      ...(gainLossPaisa < 0 ? [{ account: loss._id, debitPaisa: -gainLossPaisa }] : []),
      ...(gainLossPaisa > 0 ? [{ account: gain._id, creditPaisa: gainLossPaisa }] : [])
    ];
    const entry = await postEntry({
      business: asset.business,
      date: when,
      memo: throwAway
        ? `Thrown away ${asset.name} — Rs ${fromPaisa(bookPaisa)} written off`
        : `Sold ${asset.name} — bought Rs ${fromPaisa(asset.costPaisa)}, sold Rs ${fromPaisa(price)}`,
      source: { kind: JOURNAL_SOURCES.ASSET_SALE, ref: String(asset._id) },
      lines,
      userId
    });
    try {
      await FixedAsset.updateOne(
        { _id: asset._id },
        {
          $set: {
            depreciationPaisa: depreciation,
            updatedBy: userId,
            sale: {
              date: when,
              pricePaisa: price,
              account: price > 0 ? money.account : undefined,
              entry: entry._id,
              gainLossPaisa,
              buyerName: buyerName || undefined
            }
          }
        }
      );
    } catch (err) {
      await reverseEntry(entry._id, { userId, memo: 'Asset sale not saved — undone' });
      throw err;
    }
    return { asset: await FixedAsset.findById(asset._id), entry, gainLossPaisa };
  } catch (err) {
    await FixedAsset.updateOne({ _id: asset._id }, { $set: { status: ASSET_STATUS.IN_USE } });
    throw err;
  }
};

/** Undo a sale: reverse its entry and put the asset back in use. Only the latest action — and there is only one. */
export const undoAssetSale = async (asset, userId) => {
  if (asset.status === ASSET_STATUS.IN_USE) {
    throw new ErrorResponse('This asset has not been sold or thrown away', 400);
  }
  const entryId = asset.sale?.entry;
  if (!entryId) throw new ErrorResponse('There is no sale to undo on this asset', 400);
  if (await JournalEntry.exists({ reversalOf: entryId })) {
    throw new ErrorResponse('This sale has already been undone', 400);
  }
  const claimed = await FixedAsset.findOneAndUpdate(
    { _id: asset._id, status: { $ne: ASSET_STATUS.IN_USE } },
    { $set: { status: ASSET_STATUS.IN_USE } }
  );
  if (!claimed) throw new ErrorResponse('This sale has already been undone', 400);
  try {
    await reverseEntry(entryId, { userId, memo: `Sale undone — ${asset.name}` });
  } catch (err) {
    await FixedAsset.updateOne({ _id: asset._id }, { $set: { status: claimed.status } });
    throw err;
  }
  await FixedAsset.updateOne(
    { _id: asset._id },
    { $set: { depreciationPaisa: 0, updatedBy: userId }, $unset: { sale: '' } }
  );
  return FixedAsset.findById(asset._id);
};

/**
 * What reversing a journal entry means for an asset. The sale of an asset is undone on the asset, never from the
 * journal; the purchase of one that was sold can not be reversed until the sale is undone; the purchase of one still in
 * use may be reversed (a mistake) and the asset then reads "thrown away — purchase reversed".
 * Returns `{ refuse }` with the message, `{ asset }` to mark after reversing, or `{}` for any other entry.
 */
export const assetEntryGuard = async entry => {
  const kind = entry.source?.kind;
  if (kind === JOURNAL_SOURCES.ASSET_SALE) return { refuse: 'Undo this on the asset' };
  if (kind !== JOURNAL_SOURCES.ASSET) return {};
  const asset = await FixedAsset.findOne({ purchaseEntry: entry._id });
  if (!asset) return {};
  if (asset.status !== ASSET_STATUS.IN_USE && asset.status !== ASSET_STATUS.THROWN_AWAY) {
    return { refuse: 'This asset was sold — undo the sale first' };
  }
  if (asset.status === ASSET_STATUS.THROWN_AWAY && asset.sale?.entry) {
    return { refuse: 'This asset was thrown away — undo that first' };
  }
  return { asset };
};

/** After a purchase entry was reversed from the journal: the asset is no longer in use. */
export const markPurchaseReversed = async (asset, userId) => {
  await FixedAsset.updateOne(
    { _id: asset._id },
    { $set: { status: ASSET_STATUS.THROWN_AWAY, note: 'Purchase reversed', updatedBy: userId } }
  );
};
