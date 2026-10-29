import crypto from 'crypto';
import { presence } from '../utils/socket.js';
import asyncHandler from '../middlewares/asyncHandler.js';
import ErrorResponse from '../utils/errorResponse.js';
import User from '../models/User.js';
import Role from '../models/Role.js';
import sendEmail from '../utils/sendEmail.js';
import { getInvitationEmail } from '../templates/emails/invitation.js';
import logger from '../utils/logger.js';
import { listSessions, revokeSession, revokeOtherSessions } from '../utils/sessions.js';
import mongoose from 'mongoose';

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
    logger.error({ err }, 'failed to send invitation email');
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
 * @desc      Who is online right now (a live connection). The last-active time of everyone else
 *            is on their user record.
 * @route     GET /api/v1/users/presence
 * @access    Private (users:read)
 */
export const getPresence = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: { online: presence.onlineIds() } });
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

/**
 * The person whose devices an admin is looking at. A non-admin who may edit users can not touch an
 * Admin's sessions (it would let them cut an administrator off), and an id that is not a user is a 404.
 */
const sessionsTarget = async (req, next) => {
  const user = mongoose.isValidObjectId(req.params.id)
    ? await User.findById(req.params.id).populate('role', 'fullAccess')
    : null;
  if (!user) {
    next(new ErrorResponse(`User not found with id of ${req.params.id}`, 404));
    return null;
  }
  if (user.role?.fullAccess && !req.user.role?.fullAccess) {
    next(new ErrorResponse("Not authorized to manage an Admin's sign-ins", 403));
    return null;
  }
  return user;
};

/**
 * @desc      The devices a user is signed in on
 * @route     GET /api/v1/users/:id/sessions
 * @access    Private (users:update — the list carries addresses, so reading users is not enough)
 */
export const getUserSessions = asyncHandler(async (req, res, next) => {
  const user = await sessionsTarget(req, next);
  if (!user) return;
  const data = await listSessions(user._id);
  res.status(200).json({ success: true, count: data.length, data });
});

/**
 * @desc      Sign one of a user's devices out
 * @route     DELETE /api/v1/users/:id/sessions/:sid
 * @access    Private (users:update)
 */
export const deleteUserSession = asyncHandler(async (req, res, next) => {
  const user = await sessionsTarget(req, next);
  if (!user) return;
  const removed = mongoose.isValidObjectId(req.params.sid)
    ? await revokeSession(user._id, req.params.sid)
    : false;
  if (!removed) return next(new ErrorResponse('That device is not signed in', 404));
  logger.info(
    { by: req.user.id, userId: String(user._id), session: req.params.sid },
    'session removed by admin'
  );
  res.status(200).json({ success: true, data: {} });
});

/**
 * @desc      Sign a user out of every device
 * @route     POST /api/v1/users/:id/sign-out-all
 * @access    Private (users:update)
 *
 * Removes every session and refresh token AND bumps `tokenVersion`, so even an access token issued
 * before sessions existed (no `sid`) is dead at once.
 */
export const signOutUserEverywhere = asyncHandler(async (req, res, next) => {
  const user = await sessionsTarget(req, next);
  if (!user) return;
  const signedOut = await revokeOtherSessions(user._id);
  await User.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } });
  logger.info(
    { by: req.user.id, userId: String(user._id), signedOut },
    'user signed out everywhere by admin'
  );
  res.status(200).json({ success: true, data: { signedOut } });
});
