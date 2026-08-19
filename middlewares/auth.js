import jwt from 'jsonwebtoken';
import asyncHandler from './asyncHandler.js';
import ErrorResponse from '../utils/errorResponse.js';
import User from '../models/User.js';

/**
 * Verifies the Bearer token and loads the user WITH their role populated —
 * `can()` needs role.permissions and role.fullAccess on every request.
 */
const protect = asyncHandler(async (req, res, next) => {
  let token;

  if (req.headers.authorization?.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return next(new ErrorResponse('Not authorized to access this route', 401));
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return next(new ErrorResponse('Not authorized to access this route', 401));
  }

  req.user = await User.findById(decoded.id).select('+tokenVersion').populate('role');

  if (!req.user) {
    return next(new ErrorResponse('Not authorized to access this route', 401));
  }

  // Revocation check: a token minted before the user's tokenVersion was bumped
  // (logout, password change, forced sign-out) is dead. Nullish-coalesce to 0 so
  // tokens issued before this field existed still validate against the default.
  if ((decoded.tokenVersion ?? 0) !== (req.user.tokenVersion ?? 0)) {
    return next(new ErrorResponse('Not authorized to access this route', 401));
  }

  if (req.user.status === 'inactive') {
    return next(new ErrorResponse('Your account is inactive. Please contact administrator.', 401));
  }

  // Audit fields are stamped here so no controller has to remember to.
  // Assigning after auth also means a client cannot forge them via the body.
  // Express 5 leaves req.body undefined on a bodiless request (e.g. the
  // POST /users/:id/reinvite action), so default it before stamping.
  if (req.method === 'POST') {
    if (!req.body) req.body = {};
    req.body.createdBy = req.user.id;
  } else if (req.method === 'PUT' || req.method === 'PATCH') {
    if (!req.body) req.body = {};
    req.body.updatedBy = req.user.id;
  }

  next();
});

export { protect };
