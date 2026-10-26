import Party from '../models/Party.js';
import asyncHandler from '../middlewares/asyncHandler.js';
import ErrorResponse from '../utils/errorResponse.js';
import { lookupScope } from '../utils/partyLookup.js';
import { PARTY_TYPES } from '../utils/constants.js';

const MAX = 20;
const escape = text => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @desc   Pick a party for a task — name, phone and account id only, never a balance or a statement.
 *         Allowed for whoever has the permission for the task that needs the person (a dispatcher
 *         may pick a courier), or Khata access. See utils/partyLookup.js.
 * @route  GET /api/v1/parties/lookup?business=&type=&search=&limit=&page=  (pages like every list: `pagination.next`)
 */
export const lookupParties = asyncHandler(async (req, res, next) => {
  const { business, type, search = '' } = req.query;
  if (!business) return next(new ErrorResponse('Select a business', 400));
  if (!Object.values(PARTY_TYPES).includes(type)) {
    return next(new ErrorResponse('Choose which kind of party to look for', 400));
  }

  const scope = lookupScope(req.user, type);
  if (!scope) return next(new ErrorResponse(`You do not have permission to find a ${type}`, 403));
  // Outside your businesses is indistinguishable from not existing (root CLAUDE.md §6).
  if (
    scope === 'own' &&
    !(req.user.assignedBusinesses || []).map(String).includes(String(business))
  ) {
    return next(new ErrorResponse('Business not found', 404));
  }

  const limit = Math.min(Math.max(Number(req.query.limit) || 5, 1), MAX);
  const page = Math.max(Math.floor(Number(req.query.page)) || 1, 1);
  const find = { business, type, isActive: true };
  if (String(search).trim()) find.name = { $regex: escape(String(search).trim()), $options: 'i' };

  // One extra row says whether another page exists, without a second count query.
  const found = await Party.find(find)
    .select('name phone accountId type integration.isEnabled')
    .sort('name _id')
    .skip((page - 1) * limit)
    .limit(limit + 1)
    .lean();
  const parties = found.slice(0, limit);
  const pagination = found.length > limit ? { next: { page: page + 1, limit } } : {};

  const data = parties.map(p => ({
    _id: p._id,
    name: p.name,
    type: p.type,
    phone: p.phone,
    accountId: p.accountId,
    // Whether dispatching books with the courier's own service — all the dispatch screen needs to know.
    ...(p.type === PARTY_TYPES.COURIER
      ? { booksWithService: Boolean(p.integration?.isEnabled) }
      : {})
  }));
  res.status(200).json({ success: true, count: data.length, pagination, data });
});
