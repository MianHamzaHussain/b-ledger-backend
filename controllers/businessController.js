import Business from '../models/Business.js';
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
