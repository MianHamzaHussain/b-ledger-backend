import Business from '../models/Business.js';
import asyncHandler from '../middlewares/asyncHandler.js';
import { gettingStarted } from '../utils/gettingStarted.js';
import { createCrudHandlers } from '../utils/crudController.js';

/**
 * Businesses — standard CRUD.
 *
 * Reads are scoped: a user whose `businesses` permission has scope `own` sees
 * only their `assignedBusinesses`. Enforced by `can()` + `loadScoped` in the
 * route chain, not here. Category is populated so the client can render its
 * name without a second request.
 *
 * @route  GET    /api/v1/businesses      (businesses:read — scoped)
 * @route  GET    /api/v1/businesses/:id  (businesses:read — scoped)
 * @route  POST   /api/v1/businesses      (businesses:create)
 * @route  PUT    /api/v1/businesses/:id  (businesses:update — scoped)
 * @route  DELETE /api/v1/businesses/:id  (businesses:delete — scoped)
 */
const handlers = createCrudHandlers({
  model: Business,
  // variantOptions so the product form can offer the category's variant menu.
  populate: { path: 'category', select: 'name status variantOptions' }
});

export const {
  getAll: getBusinesses,
  getOne: getBusiness,
  create: createBusiness,
  update: updateBusiness,
  remove: deleteBusiness
} = handlers;

/**
 * @desc   The getting-started checklist for a business — each step's done flag.
 * @route  GET /api/v1/businesses/:id/getting-started  (businesses:read — scoped)
 */
export const getGettingStarted = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await gettingStarted(req.resource._id) });
});
