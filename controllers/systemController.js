import mongoose from 'mongoose';
import asyncHandler from '../middlewares/asyncHandler.js';
import ErrorResponse from '../utils/errorResponse.js';
import User from '../models/User.js';
import logger from '../utils/logger.js';

/**
 * Collections that survive a reset. Users need their roles to log in, and their
 * refresh tokens keep the admin who pressed the button signed in.
 */
const KEPT_COLLECTIONS = new Set(['users', 'roles', 'refreshtokens']);

/** The exact phrase the client must send — a stray request can't wipe data. */
export const RESET_CONFIRMATION = 'RESET';

/**
 * @desc   Wipe every business record — businesses, stock, orders, the ledger,
 *         everything — keeping only users and roles. A TESTING aid: refused
 *         unless the server opts in with ALLOW_DATA_RESET=true, so a deploy that
 *         never set it can't be wiped by a click.
 * @route  POST /api/v1/system/reset  (admin only)
 */
export const resetData = asyncHandler(async (req, res, next) => {
  if (process.env.ALLOW_DATA_RESET !== 'true') {
    return next(new ErrorResponse('Data reset is disabled on this server', 403));
  }
  if (req.body.confirm !== RESET_CONFIRMATION) {
    return next(new ErrorResponse(`Type ${RESET_CONFIRMATION} to confirm the reset`, 400));
  }

  // Every collection, not a hand-kept model list — a new model can't be missed.
  const collections = await mongoose.connection.db.collections();
  const cleared = {};
  for (const collection of collections) {
    const name = collection.collectionName;
    if (KEPT_COLLECTIONS.has(name) || name.startsWith('system.')) continue;
    const { deletedCount } = await collection.deleteMany({});
    cleared[name] = deletedCount;
  }

  // The businesses users were assigned to are gone — don't leave dangling refs.
  await User.updateMany({}, { $set: { assignedBusinesses: [] } });

  logger.warn({ userId: req.user.id, cleared }, 'all business data reset');
  res.status(200).json({ success: true, data: { cleared } });
});
