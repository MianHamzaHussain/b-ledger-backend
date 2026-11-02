import mongoose from 'mongoose';
import asyncHandler from './asyncHandler.js';
import ErrorResponse from '../utils/errorResponse.js';
import User from '../models/User.js';
import {
  assertCanManageUser,
  roleVisibilityFilter,
  userVisibilityFilter
} from '../utils/delegation.js';

/**
 * Narrow a list or lookup of users to the people the signed-in person may see. Runs AFTER `can('users', …)`, which
 * leaves a filter that matches nothing for an own-scope manager — so a route that forgets this fails closed.
 */
export const scopeUsers = asyncHandler(async (req, res, next) => {
  req.accessFilter = await userVisibilityFilter(req.user);
  next();
});

/** The same for roles. */
export const scopeRoles = (req, res, next) => {
  req.accessFilter = roleVisibilityFilter(req.user);
  next();
};

/**
 * Load the person named by `:id` — only if the signed-in person may see them (anyone else is a 404, so it never
 * confirms that someone exists in another business). With `manage: true` the person must also be someone they
 * may change: not themselves, not an Admin, not another manager. The user is left on `req.targetUser`.
 */
export const loadUser = ({ manage = false } = {}) =>
  asyncHandler(async (req, res, next) => {
    const notFound = () => new ErrorResponse(`User not found with id of ${req.params.id}`, 404);
    if (!mongoose.isValidObjectId(req.params.id)) return next(notFound());

    const visible = await userVisibilityFilter(req.user);
    const user = await User.findOne({ $and: [{ _id: req.params.id }, visible] }).populate('role');
    if (!user) return next(notFound());

    if (manage) await assertCanManageUser(req.user, user);
    req.targetUser = user;
    next();
  });
