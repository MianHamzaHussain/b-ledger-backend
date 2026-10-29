import User from '../models/User.js';
import sendEmail from './sendEmail.js';
import getNewSignInEmail from '../templates/emails/newSignIn.js';
import logger from './logger.js';
import { deviceFingerprint, deviceLabel } from './userAgent.js';
import { deviceFromRequest } from './sessions.js';

/**
 * The only door to the mail server for this alert — tests replace `send`, so no test can reach a real
 * SMTP server (or send a real email from a developer's machine that has one configured).
 */
export const signInAlertDeps = { send: options => sendEmail(options) };

/** Enough familiar devices to cover a person's phone, laptops and a shop computer or two. */
const KEEP_DEVICES = 20;

const pakistanTime = date =>
  new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Karachi'
  }).format(date);

/**
 * Called at sign-in with the user loaded `+knownDevices`. A device this person has not signed in from
 * before gets one email, so a stranger's sign-in does not go unnoticed. Returns what it did, for tests:
 *   'known'    — a familiar device
 *   'recorded' — first time we track this person (a new account, or an old one right after the release):
 *                remembered silently, so nobody is alerted about every device they already used
 *   'alerted'  — a new device on a tracked account: emailed
 * The email is best-effort and never delays or fails the sign-in.
 */
export const noteSignIn = async (
  user,
  req,
  { send = signInAlertDeps.send, now = new Date() } = {}
) => {
  const device = deviceFromRequest(req);
  const fingerprint = deviceFingerprint(device);
  const known = user.knownDevices;
  if (known?.includes(fingerprint)) return 'known';

  await User.updateOne(
    { _id: user._id },
    { $push: { knownDevices: { $each: [fingerprint], $slice: -KEEP_DEVICES } } }
  );

  if (known === undefined || !user.lastLogin || !user.email) return 'recorded';

  send({
    email: user.email,
    subject: 'New sign-in to your account',
    message: `Your account was signed in from a new device: ${deviceLabel(device)}${
      device.ip ? ` (${device.ip})` : ''
    } at ${pakistanTime(now)}. If this was not you, sign in, sign that device out and change your password.`,
    html: getNewSignInEmail({
      name: user.name,
      device: deviceLabel(device),
      ip: device.ip,
      when: pakistanTime(now)
    })
  }).catch(err => logger.warn({ err, userId: String(user._id) }, 'new sign-in email failed'));
  return 'alerted';
};
