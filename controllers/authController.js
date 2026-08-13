import crypto from 'crypto';
import ErrorResponse from '../utils/errorResponse.js';
import sendEmail from '../utils/sendEmail.js';
import asyncHandler from '../middlewares/asyncHandler.js';
import User from '../models/User.js';
import getPasswordResetEmail from '../templates/emails/passwordReset.js';
import logger from '../utils/logger.js';

/** Issues the JWT. Kept in one place so claims stay consistent. */
const sendTokenResponse = (user, statusCode, res) => {
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

  sendTokenResponse(user, 200, res);
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
    new: true,
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

  const user = await User.findById(req.user.id).select('+password +mustChangePassword');

  if (!(await user.matchPassword(currentPassword))) {
    return next(new ErrorResponse('Password is incorrect', 401));
  }

  user.password = newPassword;
  user.mustChangePassword = false;
  await user.save();

  sendTokenResponse(user, 200, res);
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
  }).select('+mustChangePassword');

  if (!user || user.status === 'inactive') {
    return next(new ErrorResponse('Invalid or expired token', 400));
  }

  user.password = req.body.password;
  user.resetPasswordToken = undefined;
  user.resetPasswordExpire = undefined;
  user.mustChangePassword = false;
  // Setting a password from the emailed link signs the user in — so it counts
  // as a login and marks the account verified.
  user.lastLogin = new Date();
  await user.save();

  sendTokenResponse(user, 200, res);
});

/**
 * @desc      Logout
 * @route     GET /api/v1/auth/logout
 * @access    Private
 *
 * JWTs are stateless, so this cannot revoke the token — the client must
 * discard it. Kept as an endpoint for client symmetry and future denylisting.
 */
export const logout = asyncHandler(async (req, res, next) => {
  res.status(200).json({ success: true, data: {} });
});
