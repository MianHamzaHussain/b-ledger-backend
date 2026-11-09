import mongoose from 'mongoose';
import asyncHandler from '../middlewares/asyncHandler.js';
import ErrorResponse from '../utils/errorResponse.js';
import Business from '../models/Business.js';
import Order from '../models/Order.js';
import Party from '../models/Party.js';
import {
  businessModels,
  countBusinessData,
  countKept,
  labelOf,
  resetFilter,
  snapshotBusiness
} from '../utils/businessData.js';
import { KIND_WORDS, clearLedger, planLedgerClear } from '../utils/ledgerClear.js';
import { fromPaisa } from '../utils/money.js';
import logger from '../utils/logger.js';
import { PAKISTAN_CITIES } from '../utils/cities.js';

/**
 * @desc   The standard city list the order form offers — one source of truth, so
 *         the form and the courier report agree on what a city is called.
 * @route  GET /api/v1/system/cities  (any signed-in user)
 */
export const getCities = (req, res) => {
  res.status(200).json({ success: true, data: PAKISTAN_CITIES });
};

const loadBusiness = async id => {
  const business = mongoose.isValidObjectId(id) ? await Business.findById(id) : null;
  if (!business) throw new ErrorResponse('Business not found', 404);
  return business;
};

/**
 * @desc   What clearing one business would delete — counts per kind, plus the signals an
 *         admin needs to tell test data from real (the last order, the protection lock).
 * @route  GET /api/v1/system/reset-preview?business=<id>  (admin only)
 */
export const resetPreview = asyncHandler(async (req, res) => {
  const business = await loadBusiness(req.query.business);
  const lastOrder = await Order.findOne({ business: business._id }, 'createdAt')
    .sort({ createdAt: -1 })
    .lean();
  res.status(200).json({
    success: true,
    data: {
      business: { _id: business._id, name: business.name, isProtected: business.isProtected },
      counts: await countBusinessData(business._id),
      kept: await countKept(business._id),
      lastOrderAt: lastOrder?.createdAt ?? null
    }
  });
});

/**
 * @desc   Delete every record of ONE business, keeping the business itself, its assigned users,
 *         roles, categories and the order-number counter. A TESTING aid: refused unless the
 *         server opts in with ALLOW_DATA_RESET=true, refused for a business marked protected
 *         ("real data"), and only done when the business's exact name is typed — a phrase no
 *         one types by habit. A copy of its records is written first.
 * @route  POST /api/v1/system/reset  (admin only)
 */
export const resetData = asyncHandler(async (req, res, next) => {
  if (process.env.ALLOW_DATA_RESET !== 'true') {
    return next(new ErrorResponse('Data reset is disabled on this server', 403));
  }
  const business = await loadBusiness(req.body.business);
  if (req.body.confirmName.trim() !== business.name) {
    return next(new ErrorResponse(`Type the business name exactly: ${business.name}`, 400));
  }
  if (business.isProtected) {
    return next(
      new ErrorResponse(
        'This business is protected as real data — turn the protection off first',
        403
      )
    );
  }

  const snapshot = await snapshotBusiness(business);

  const cleared = {};
  for (const model of businessModels()) {
    const filter = resetFilter(model, business._id);
    if (!filter) continue; // the Shopify connection stays
    const { deletedCount } = await model.deleteMany(filter);
    cleared[labelOf(model)] = deletedCount;
  }
  // The money accounts are gone, so a connected courier's saved "where it pays" points at nothing.
  await Party.updateMany(
    { business: business._id, 'integration.provider': { $exists: true } },
    { $unset: { defaultMoneyAccount: 1 } }
  );

  logger.warn(
    { userId: req.user.id, business: String(business._id), name: business.name, cleared, snapshot },
    'business data reset'
  );
  res.status(200).json({ success: true, data: { cleared } });
});

const ledgerClearOn = () => process.env.ALLOW_LEDGER_CLEAR === 'true';

/** The plan in plain words and rupees — what the screen shows before anyone types the name. */
const present = plan => ({
  entries: plan.count,
  byKind: Object.entries(plan.countsByKind).map(([kind, count]) => ({
    kind,
    label: KIND_WORDS[kind] ?? kind,
    count
  })),
  periodLocks: plan.periodLocks,
  balances: plan.balances.map(b => ({
    kind: b.kind,
    id: b.id,
    name: b.name,
    partyType: b.partyType ?? null,
    now: fromPaisa(b.nowPaisa),
    after: fromPaisa(b.afterPaisa)
  }))
});

/**
 * @desc   What clearing the HAND-ENTERED money of one business would delete, and every money account's and khata
 *         person's balance now -> after. Reads only.
 * @route  GET /api/v1/system/ledger-clear-preview?business=<id>  (admin only)
 */
export const ledgerClearPreview = asyncHandler(async (req, res) => {
  const business = await loadBusiness(req.query.business);
  res.status(200).json({
    success: true,
    data: {
      business: { _id: business._id, name: business.name, isProtected: business.isProtected },
      enabled: ledgerClearOn(),
      ...present(await planLedgerClear(business._id))
    }
  });
});

/**
 * @desc   Delete the entries a person typed by hand (expenses, payments, transfers, capital, salaries, opening
 *         balances, manual entries) and the period locks of ONE business. Orders, customer advances and refunds,
 *         courier invoices, PostEx receipts, the PostEx wallet and every connection stay. Allowed on a protected
 *         business, but only when the server opts in (ALLOW_LEDGER_CLEAR=true) and the exact name is typed; a copy
 *         of what is deleted is written first.
 * @route  POST /api/v1/system/ledger-clear  (admin only)
 */
export const ledgerClear = asyncHandler(async (req, res, next) => {
  if (!ledgerClearOn()) {
    return next(new ErrorResponse('Clearing the ledger is switched off on this server', 403));
  }
  const business = await loadBusiness(req.body.business);
  if (req.body.confirmName.trim() !== business.name) {
    return next(new ErrorResponse(`Type the business name exactly: ${business.name}`, 400));
  }
  const out = await clearLedger({ business: business._id, userId: req.user.id });
  res.status(200).json({
    success: true,
    data: {
      deleted: out.deleted,
      periodLocks: out.periodLocks,
      byKind: Object.entries(out.countsByKind).map(([kind, count]) => ({
        kind,
        label: KIND_WORDS[kind] ?? kind,
        count
      })),
      balances: out.balances.map(b => ({
        kind: b.kind,
        id: b.id,
        name: b.name,
        now: fromPaisa(b.nowPaisa),
        after: fromPaisa(b.afterPaisa)
      }))
    }
  });
});
