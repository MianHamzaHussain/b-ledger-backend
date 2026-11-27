import asyncHandler from '../middlewares/asyncHandler.js';
import FixedAsset from '../models/FixedAsset.js';
import ErrorResponse from '../utils/errorResponse.js';
import { sellAsset, undoAssetSale } from '../utils/fixedAssets.js';
import { resolveMoney } from '../utils/moneyAccounts.js';
import { inScope } from '../utils/scope.js';
import { userCan } from '../utils/permissions.js';
import { toPaisa, fromPaisa } from '../utils/money.js';

/** An asset as the screens read it: rupees beside paisa, and what it is worth on paper (cost less depreciation). */
const present = asset => {
  const a = asset.toObject ? asset.toObject() : asset;
  return {
    ...a,
    cost: fromPaisa(a.costPaisa),
    depreciation: fromPaisa(a.depreciationPaisa ?? 0),
    bookValue: fromPaisa(a.costPaisa - (a.depreciationPaisa ?? 0)),
    sale: a.sale
      ? {
          ...a.sale,
          price: fromPaisa(a.sale.pricePaisa ?? 0),
          gainLoss: fromPaisa(a.sale.gainLossPaisa ?? 0)
        }
      : undefined
  };
};

/**
 * @desc   The business's fixed assets, newest first — what it bought to keep and use, with what became of each.
 * @route  GET /api/v1/finance/assets?business=&status=in-use|sold|thrown-away  (journal:read — scoped)
 */
export const getAssets = asyncHandler(async (req, res, next) => {
  const { business, status } = req.query;
  if (!inScope(req, business)) return next(new ErrorResponse('Business not found', 404));
  const assets = await FixedAsset.find({ business, ...(status ? { status } : {}) })
    .sort({ boughtOn: -1, createdAt: -1 })
    .lean();
  res.status(200).json({
    success: true,
    count: assets.length,
    total: assets.length,
    data: assets.map(present)
  });
});

/**
 * @desc   One asset.
 * @route  GET /api/v1/finance/assets/:id  (journal:read — scoped)
 */
export const getAsset = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: present(req.resource) });
});

/**
 * @desc   Sell a fixed asset, or throw it away (`throwAway`). The app knows what it cost, so it books the gain or the
 *         loss itself: bought 2,800, sold 2,500 → a Rs 300 loss. Only an accountant may say how much depreciation
 *         belongs to the item.
 * @route  POST /api/v1/finance/assets/:id/sell  (journal:create — scoped)
 */
export const sellFixedAsset = asyncHandler(async (req, res, next) => {
  const asset = req.resource;
  const { price = 0, method, account, date, buyerName, depreciation, throwAway } = req.body;
  if (depreciation !== undefined && !userCan(req.user, 'accounting', 'create')) {
    return next(new ErrorResponse('Only an accountant can set the depreciation of an asset', 403));
  }
  if (!throwAway && !(price > 0) && !account && !method) {
    // A sale for nothing is a throw-away; ask which, rather than guessing.
    return next(new ErrorResponse('Enter what it sold for, or choose "Threw it away"', 400));
  }
  const pricePaisa = throwAway ? 0 : toPaisa(price);
  if (pricePaisa > 0 && !account && !method) {
    return next(new ErrorResponse('Choose where the money came in', 400));
  }
  const money =
    pricePaisa > 0 ? await resolveMoney(asset.business, { account, method }, req.user) : null;

  const out = await sellAsset(asset, {
    pricePaisa,
    money,
    date,
    buyerName,
    depreciationPaisa: depreciation === undefined ? undefined : toPaisa(depreciation),
    throwAway: Boolean(throwAway) || pricePaisa === 0,
    userId: req.user.id
  });
  res.status(200).json({
    success: true,
    data: { ...present(out.asset), gainLoss: fromPaisa(out.gainLossPaisa) }
  });
});

/**
 * @desc   Undo a sale or a throw-away: its entry is reversed and the asset is back in use.
 * @route  POST /api/v1/finance/assets/:id/undo-sale  (journal:create — scoped)
 */
export const undoFixedAssetSale = asyncHandler(async (req, res) => {
  const asset = await undoAssetSale(req.resource, req.user.id);
  res.status(200).json({ success: true, data: present(asset) });
});
