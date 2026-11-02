import asyncHandler from '../middlewares/asyncHandler.js';
import ErrorResponse from '../utils/errorResponse.js';
import Role from '../models/Role.js';
import User from '../models/User.js';
import { getPermissionRegistry } from '../utils/permissions.js';
import {
  assertCanWriteRole,
  assertWithinCeiling,
  grantableFor,
  isAdmin
} from '../utils/delegation.js';

/**
 * @desc      Get the permission registry (resources, actions, scopes)
 * @route     GET /api/v1/roles/registry
 * @access    Private (roles:read)
 *
 * The admin UI calls this to render its checkbox grid. Resource names are
 * never hardcoded in the frontend.
 */
export const getRegistry = asyncHandler(async (req, res, next) => {
  // `grantable` is what this person may put in a role: null = everything (Admin), otherwise only what they hold.
  // The server enforces it again on save; the screen uses it to grey out the rest.
  res.status(200).json({
    success: true,
    data: { ...getPermissionRegistry(), grantable: grantableFor(req.user) }
  });
});

/**
 * @desc      Get all roles
 * @route     GET /api/v1/roles
 * @access    Private (roles:read)
 */
export const getRoles = asyncHandler(async (req, res, next) => {
  res.status(200).json(res.advancedResults);
});

/**
 * @desc      Get single role
 * @route     GET /api/v1/roles/:id
 * @access    Private (roles:read)
 */
export const getRole = asyncHandler(async (req, res, next) => {
  res.status(200).json({ success: true, data: req.resource });
});

/**
 * @desc      Create role
 * @route     POST /api/v1/roles
 * @access    Private (roles:create)
 */
export const createRole = asyncHandler(async (req, res, next) => {
  // fullAccess and isSystem are seeder-only. Accepting them from the wire
  // would let anyone with roles:create mint themselves an admin.
  delete req.body.fullAccess;
  delete req.body.isSystem;
  // Only an Admin marks a role as one owners may give out; `createdBy` is the signed-in person, never the payload.
  if (!isAdmin(req.user)) delete req.body.delegable;
  req.body.createdBy = req.user.id;

  assertCanWriteRole(req.user, req.body);
  assertWithinCeiling(req.user, req.body.permissions);

  const role = await Role.create(req.body);

  res.status(201).json({ success: true, data: role });
});

/**
 * @desc      Update role
 * @route     PUT /api/v1/roles/:id
 * @access    Private (roles:update)
 */
export const updateRole = asyncHandler(async (req, res, next) => {
  const role = req.resource;

  if (role.isSystem) {
    return next(new ErrorResponse('System roles cannot be modified', 403));
  }
  assertCanWriteRole(req.user, role);

  delete req.body.fullAccess;
  delete req.body.isSystem;
  delete req.body.createdBy;
  // Whose role it is, and whether owners may give it out, do not change through an edit by anyone but an Admin.
  if (!isAdmin(req.user)) {
    delete req.body.business;
    delete req.body.delegable;
  }
  assertWithinCeiling(req.user, req.body.permissions);

  Object.assign(role, req.body);
  await role.save();

  res.status(200).json({ success: true, data: role });
});

/**
 * @desc      Delete role
 * @route     DELETE /api/v1/roles/:id
 * @access    Private (roles:delete)
 */
export const deleteRole = asyncHandler(async (req, res, next) => {
  const role = req.resource;

  if (role.isSystem) {
    return next(new ErrorResponse('System roles cannot be deleted', 403));
  }
  assertCanWriteRole(req.user, role);

  // Users are required to have a role, so deleting one out from under them
  // would leave unloadable accounts.
  const inUse = await User.countDocuments({ role: role._id });
  if (inUse > 0) {
    return next(
      new ErrorResponse(
        `Cannot delete this role — ${inUse} user(s) are assigned to it. Reassign them first.`,
        400
      )
    );
  }

  await role.deleteOne();

  res.status(200).json({ success: true, data: {} });
});
