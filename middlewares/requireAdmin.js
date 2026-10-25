import ErrorResponse from '../utils/errorResponse.js';

/**
 * Admin only — for what must never be grantable to anyone else (it is not a resource on the
 * permission grid). Admin = the full-access role, and roles are data.
 */
export const requireAdmin = (req, res, next) =>
  req.user.role?.fullAccess ? next() : next(new ErrorResponse('Only an admin can do this', 403));
