import ErrorResponse from '../utils/errorResponse.js';
import asyncHandler from './asyncHandler.js';
import { RESOURCES, resolvePermissions } from '../utils/permissions.js';

/**
 * The single authorization choke point. Every protected route declares what it
 * needs; nothing else in the codebase decides who may do what.
 *
 *   router.route('/').get(can('businesses', 'read'), getBusinesses)
 *
 * On success it sets:
 *   req.permissionScope — 'all' | 'own'
 *   req.accessFilter    — Mongo filter fragment ({} when scope is 'all')
 *
 * `advancedResults` refuses to run if `req.accessFilter` is undefined, so a
 * list route that forgets to declare a permission fails closed rather than
 * leaking every row.
 *
 * @param {string} resource - key from the permission registry
 * @param {string} action   - 'read' | 'create' | 'update' | 'delete'
 */
export const can = (resource, action) => (req, res, next) => {
  if (!RESOURCES[resource]) {
    // Programmer error, not a user error — fail loudly at request time.
    return next(new ErrorResponse(`Resource "${resource}" is not in the permission registry`, 500));
  }

  if (!req.user) {
    return next(new ErrorResponse('Not authorized to access this route', 401));
  }

  // Admin bypass — deliberately BEFORE any matrix lookup, so a mis-ticked
  // checkbox can never lock an admin out of user or role management.
  if (req.user.role?.fullAccess) {
    req.permissionScope = 'all';
    req.accessFilter = {};
    return next();
  }

  const entry = resolvePermissions(req.user).get(resource);

  if (!entry || !entry.actions.has(action)) {
    return next(new ErrorResponse(`You do not have permission to ${action} ${resource}`, 403));
  }

  req.permissionScope = entry.scope;
  req.accessFilter =
    entry.scope === 'own' && RESOURCES[resource].ownFilter
      ? RESOURCES[resource].ownFilter(req.user)
      : {};

  next();
};

/**
 * Record-level guard for GET-one / PUT / DELETE.
 *
 * Applies the same `req.accessFilter` that scopes list queries to a single
 * document, so "dispatcher can only open their own businesses' orders" needs
 * no per-controller logic. The loaded document is cached on `req.resource` so
 * the controller does not re-query.
 *
 * $and is used rather than object spread because the scope filter often
 * contains its own `_id` clause, which a spread would silently overwrite.
 *
 * @param {mongoose.Model} model
 * @param {string} idParam - req.params key holding the id (default 'id')
 */
export const loadScoped = (model, idParam = 'id') =>
  asyncHandler(async (req, res, next) => {
    const scopeFilter = req.accessFilter || {};

    const query = Object.keys(scopeFilter).length
      ? { $and: [{ _id: req.params[idParam] }, scopeFilter] }
      : { _id: req.params[idParam] };

    const doc = await model.findOne(query);

    // Deliberately 404, not 403: telling a user "this exists but is not yours"
    // leaks the existence of other businesses' records.
    if (!doc) {
      return next(
        new ErrorResponse(`${model.modelName} not found with id of ${req.params[idParam]}`, 404)
      );
    }

    req.resource = doc;
    next();
  });

/**
 * Stops a scoped user creating/moving a record into a business they are not
 * assigned to.
 *
 * `can()` set `req.accessFilter.business = { $in: [...assigned] }` for scope
 * 'own'. `loadScoped` already covers reads and existing records; this covers
 * the write payload — the `business` a POST/PUT is trying to set. Admins
 * (scope 'all', empty filter) pass straight through.
 *
 * @param {string} field - body field holding the business id (default 'business')
 */
export const restrictBusinessToScope =
  (field = 'business') =>
  (req, res, next) => {
    const allowed = req.accessFilter?.[field]?.$in;
    const target = req.body?.[field];

    if (allowed && target && !allowed.map(String).includes(String(target))) {
      return next(new ErrorResponse('You are not assigned to that business', 403));
    }

    next();
  };
