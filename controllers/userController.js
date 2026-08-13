import crypto from 'crypto';
import asyncHandler from '../middlewares/asyncHandler.js';
import ErrorResponse from '../utils/errorResponse.js';
import User from '../models/User.js';
import Role from '../models/Role.js';
import sendEmail from '../utils/sendEmail.js';
import { getInvitationEmail } from '../templates/emails/invitation.js';

/** Invite links live for 24h — long enough for a new hire to act, short enough to expire. */
const INVITE_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * Generate a fresh 24h invite token, persist it, and email the set-password
 * link. Returns whether the email went out — the account exists regardless, so
 * a bounced email is reported, not thrown. Shared by create and reinvite.
 */
const sendInvite = async user => {
  const inviteToken = user.getResetPasswordToken(INVITE_EXPIRY_MS);
  await user.save();

  const inviteUrl = `${process.env.FRONTEND_URL}/set-password/${inviteToken}`;

  try {
    await sendEmail({
      email: user.email,
      subject: `You have been invited to ${process.env.APP_NAME || 'B Ledger'}`,
      message: `You have been invited. Set your password here: ${inviteUrl}`,
      html: getInvitationEmail(user.name, inviteUrl)
    });
    return true;
  } catch (err) {
    console.error('Failed to send invitation email:', err.message);
    return false;
  }
};

/**
 * @desc      Get all users
 * @route     GET /api/v1/users
 * @access    Private (users:read)
 */
export const getUsers = asyncHandler(async (req, res, next) => {
  res.status(200).json(res.advancedResults);
});

/**
 * @desc      Get single user
 * @route     GET /api/v1/users/:id
 * @access    Private (users:read)
 */
export const getUser = asyncHandler(async (req, res, next) => {
  const user = await User.findById(req.params.id)
    .populate('role', 'name description')
    .populate('assignedBusinesses', 'name category');

  if (!user) {
    return next(new ErrorResponse(`User not found with id of ${req.params.id}`, 404));
  }

  res.status(200).json({ success: true, data: user });
});

/**
 * @desc      Create user and email them an invitation link
 * @route     POST /api/v1/users
 * @access    Private (users:create)
 *
 * No password is chosen or emailed. The account is created with an unguessable
 * throwaway secret and the user sets their own via a single-use invite link —
 * so a credential never travels over SMTP.
 */
export const createUser = asyncHandler(async (req, res, next) => {
  const role = await Role.findById(req.body.role);

  if (!role) {
    return next(new ErrorResponse('Please assign a valid role', 400));
  }

  // Only an admin may hand out the keys to the kingdom.
  if (role.fullAccess && !req.user.role?.fullAccess) {
    return next(new ErrorResponse('Not authorized to assign the Admin role', 403));
  }

  const user = new User({
    ...req.body,
    password: crypto.randomBytes(32).toString('hex'),
    mustChangePassword: true
  });

  const emailSent = await sendInvite(user);

  res.status(201).json({
    success: true,
    data: await user.populate('role', 'name description'),
    emailSent
  });
});

/**
 * @desc      Resend a user's invitation (new 24h link)
 * @route     POST /api/v1/users/:id/reinvite
 * @access    Private (users:create)
 *
 * Only for accounts that have never signed in — a fresh token invalidates any
 * previous link. An activated account has no invite to resend.
 */
export const reinviteUser = asyncHandler(async (req, res, next) => {
  const user = await User.findById(req.params.id);

  if (!user) {
    return next(new ErrorResponse(`User not found with id of ${req.params.id}`, 404));
  }

  if (user.lastLogin) {
    return next(new ErrorResponse('This user has already activated their account', 400));
  }

  const emailSent = await sendInvite(user);

  res.status(200).json({ success: true, data: {}, emailSent });
});

/**
 * @desc      Update user
 * @route     PUT /api/v1/users/:id
 * @access    Private (users:update)
 */
export const updateUser = asyncHandler(async (req, res, next) => {
  const user = await User.findById(req.params.id);

  if (!user) {
    return next(new ErrorResponse(`User not found with id of ${req.params.id}`, 404));
  }

  // Passwords are changed by their owner through /auth/updatepassword, never
  // set for someone else here.
  delete req.body.password;

  if (req.body.role) {
    const role = await Role.findById(req.body.role);
    if (!role) {
      return next(new ErrorResponse('Please assign a valid role', 400));
    }
    if (role.fullAccess && !req.user.role?.fullAccess) {
      return next(new ErrorResponse('Not authorized to assign the Admin role', 403));
    }
  }

  Object.assign(user, req.body);
  await user.save();

  res.status(200).json({
    success: true,
    data: await user.populate('role', 'name description')
  });
});

/**
 * @desc      Delete user
 * @route     DELETE /api/v1/users/:id
 * @access    Private (users:delete)
 */
export const deleteUser = asyncHandler(async (req, res, next) => {
  const user = await User.findById(req.params.id);

  if (!user) {
    return next(new ErrorResponse(`User not found with id of ${req.params.id}`, 404));
  }

  if (user.id === req.user.id) {
    return next(new ErrorResponse('You cannot delete your own account', 400));
  }

  await user.deleteOne();

  res.status(200).json({ success: true, data: {} });
});
