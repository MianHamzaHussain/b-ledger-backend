import crypto from 'crypto';
import ErrorResponse from '../utils/errorResponse.js';
import sendEmail from '../utils/sendEmail.js';
import asyncHandler from '../middlewares/asyncHandler.js';
import User from '../models/User.js';
import getPasswordResetEmail from '../templates/emails/passwordReset.js';
import logger from '../utils/logger.js';
import {
  REFRESH_COOKIE,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  refreshCookieOptions,
  clearCookieOptions
} from '../utils/refreshTokens.js';

/**
 * Issues the short-lived access token in the body AND a long-lived refresh token
 * as an httpOnly cookie. The access token lives in memory on the client; the
 * refresh cookie — which JS can't read — is what survives a reload and is traded
 * for a new access token at /auth/refresh. Async because it persists the token.
 */
const sendTokenResponse = async (user, statusCode, res) => {
  const { token, expiresAt } = await issueRefreshToken(user._id);
  res.cookie(REFRESH_COOKIE, token, refreshCookieOptions(expiresAt));
  res.status(statusCode).json({
    success: true,
    token: user.getSignedJwtToken(),
    mustChangePassword: Boolean(user.mustChangePassword)
  });
};

/**
 * @desc      Login
 * @route     POST /api/v1/auth/login
 * @access    Public
 */
export const login = asyncHandler(async (req, res, next) => {
  const { email, phone, password } = req.body;
  const identifier = email || phone;

  if (!identifier || !password) {
    return next(new ErrorResponse('Please provide an email/phone and password', 400));
  }

  const user = await User.findOne({
    $or: [{ email: identifier.toLowerCase() }, { phone: identifier }]
  }).select('+password +mustChangePassword');

  // Same message and same code path for "no such user" and "wrong password",
  // so the response cannot be used to enumerate accounts.
  if (!user || !(await user.matchPassword(password))) {
    return next(new ErrorResponse('Invalid credentials', 401));
  }

  if (user.status === 'inactive') {
    return next(new ErrorResponse('Your account is inactive. Please contact administrator.', 401));
  }

  // Stamp the sign-in (drives "last login" and the verified badge). updateOne
  // rather than save() to skip the password-hash hook on an unchanged password.
  await User.updateOne({ _id: user._id }, { $set: { lastLogin: new Date() } });

  await sendTokenResponse(user, 200, res);
});

/**
 * @desc      Get current logged in user
 * @route     GET /api/v1/auth/me
 * @access    Private
 *
 * Returns the resolved permission set so the frontend can hide controls the
 * user cannot use. This is a convenience for the UI — the server still
 * enforces every permission independently.
 */
export const getMe = asyncHandler(async (req, res, next) => {
  const user = await User.findById(req.user.id)
    .select('+mustChangePassword')
    .populate('role')
    .populate({
      path: 'assignedBusinesses',
      select: 'name category',
      // variantOptions so the product form can offer the category's variant menu.
      populate: { path: 'category', select: 'name variantOptions' }
    });

  res.status(200).json({ success: true, data: user });
});

/**
 * @desc      Update own details
 * @route     PUT /api/v1/auth/updatedetails
 * @access    Private
 */
export const updateDetails = asyncHandler(async (req, res, next) => {
  // Whitelist: a user must not be able to change their own role, permission
  // overrides, business assignments or status by posting extra fields.
  const fieldsToUpdate = {};
  if (req.body.name) fieldsToUpdate.name = req.body.name;
  if (req.body.phone) fieldsToUpdate.phone = req.body.phone;

  if (req.body.phone) {
    const existing = await User.findOne({ phone: req.body.phone });
    if (existing && existing.id !== req.user.id) {
      return next(new ErrorResponse('Phone number already in use', 400));
    }
  }

  const user = await User.findByIdAndUpdate(req.user.id, fieldsToUpdate, {
    returnDocument: 'after',
    runValidators: true
  }).populate('role', 'name description');

  res.status(200).json({ success: true, data: user });
});

/**
 * @desc      Update own password
 * @route     PUT /api/v1/auth/updatepassword
 * @access    Private
 */
export const updatePassword = asyncHandler(async (req, res, next) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return next(new ErrorResponse('Please provide the current and new password', 400));
  }

  const user = await User.findById(req.user.id).select(
    '+password +mustChangePassword +tokenVersion'
  );

  if (!(await user.matchPassword(currentPassword))) {
    return next(new ErrorResponse('Password is incorrect', 401));
  }

  user.password = newPassword;
  user.mustChangePassword = false;
  // Revoke every other session minted under the old password; the token issued
  // just below carries the new version, so the current device stays signed in.
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;
  await user.save();

  await sendTokenResponse(user, 200, res);
});

/**
 * @desc      Request a password reset link
 * @route     POST /api/v1/auth/forgotpassword
 * @access    Public
 */
export const forgotPassword = asyncHandler(async (req, res, next) => {
  const user = await User.findOne({ email: req.body.email?.toLowerCase() });

  // Always report success. Revealing whether an address is registered turns
  // this endpoint into an account-enumeration oracle.
  const genericResponse = () =>
    res.status(200).json({
      success: true,
      data: 'If that email is registered, a reset link has been sent.'
    });

  if (!user || user.status === 'inactive') return genericResponse();

  const resetToken = user.getResetPasswordToken();
  await user.save({ validateBeforeSave: false });

  const resetUrl = `${process.env.FRONTEND_URL}/reset-password/${resetToken}`;

  try {
    await sendEmail({
      email: user.email,
      subject: 'Password Reset Request',
      message: `Reset your password here: ${resetUrl}`,
      html: getPasswordResetEmail(user.name, resetUrl)
    });
  } catch (err) {
    logger.error({ err }, 'password reset email failed');
    user.resetPasswordToken = undefined;
    user.resetPasswordExpire = undefined;
    await user.save({ validateBeforeSave: false });
    return next(new ErrorResponse('Email could not be sent', 500));
  }

  genericResponse();
});

/**
 * @desc      Reset password with a token (also used for the invite link)
 * @route     PUT /api/v1/auth/resetpassword/:resettoken
 * @access    Public
 */
export const resetPassword = asyncHandler(async (req, res, next) => {
  if (!req.body.password) {
    return next(new ErrorResponse('Please provide a new password', 400));
  }

  const resetPasswordToken = crypto
    .createHash('sha256')
    .update(req.params.resettoken)
    .digest('hex');

  const user = await User.findOne({
    resetPasswordToken,
    resetPasswordExpire: { $gt: Date.now() }
  }).select('+mustChangePassword +tokenVersion');

  if (!user || user.status === 'inactive') {
    return next(new ErrorResponse('Invalid or expired token', 400));
  }

  user.password = req.body.password;
  user.resetPasswordToken = undefined;
  user.resetPasswordExpire = undefined;
  user.mustChangePassword = false;
  // A reset kills any session that survived on the old password (e.g. after a
  // "forgot password" on a compromised account).
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;
  // Setting a password from the emailed link signs the user in — so it counts
  // as a login and marks the account verified.
  user.lastLogin = new Date();
  await user.save();

  await sendTokenResponse(user, 200, res);
});

/**
 * @desc      Exchange the refresh cookie for a fresh access token
 * @route     POST /api/v1/auth/refresh
 * @access    Public (authenticated by the httpOnly cookie, not a Bearer token)
 *
 * Rotates the refresh token on every call: the presented one is consumed and a
 * new cookie is set, so a stolen-and-replayed token fails once the real client
 * has rotated. Also re-checks account status and tokenVersion, so a revoked or
 * inactive user can't refresh their way back in.
 */
export const refreshAccessToken = asyncHandler(async (req, res, next) => {
  const rotated = await rotateRefreshToken(req.cookies?.[REFRESH_COOKIE]);

  if (!rotated) {
    res.clearCookie(REFRESH_COOKIE, clearCookieOptions());
    return next(new ErrorResponse('Not authorized to access this route', 401));
  }

  const user = await User.findById(rotated.userId).select('+tokenVersion').populate('role');

  if (!user || user.status === 'inactive') {
    res.clearCookie(REFRESH_COOKIE, clearCookieOptions());
    return next(new ErrorResponse('Not authorized to access this route', 401));
  }

  res.cookie(REFRESH_COOKIE, rotated.token, refreshCookieOptions(rotated.expiresAt));
  res.status(200).json({ success: true, token: user.getSignedJwtToken() });
});

/**
 * @desc      Logout
 * @route     GET /api/v1/auth/logout
 * @access    Private
 *
 * Revokes this device's refresh token, clears the cookie, and bumps
 * `tokenVersion` (which `protect` re-checks) so the short access token is dead
 * server-side immediately too. One counter per user means this signs out every
 * device — the honest behaviour without per-session tracking.
 */
export const logout = asyncHandler(async (req, res, next) => {
  await revokeRefreshToken(req.cookies?.[REFRESH_COOKIE]);
  res.clearCookie(REFRESH_COOKIE, clearCookieOptions());
  await User.updateOne({ _id: req.user.id }, { $inc: { tokenVersion: 1 } });
  res.status(200).json({ success: true, data: {} });
});
