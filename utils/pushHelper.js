import webpush from 'web-push';
import User from '../models/User.js';
import Role from '../models/Role.js';
import logger from './logger.js';

let isVapidInitialized = false;

/** Ids of roles that see everything, so admins receive all notifications. */
const fullAccessRoleIds = async () => {
  const roles = await Role.find({ fullAccess: true }).select('_id');
  return roles.map(r => r._id);
};

const initVapid = () => {
  if (isVapidInitialized) return true;

  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;

  webpush.setVapidDetails(
    process.env.VAPID_MAILTO || 'mailto:admin@example.com',
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
  isVapidInitialized = true;
  return true;
};

/**
 * Send a PWA background notification to everyone entitled to a business's
 * events: users assigned to it, plus all full-access admins.
 *
 * Audience is derived from the same assignment data the permission system
 * uses, so a notification can never reach someone who could not open the
 * record it refers to.
 *
 * @param {string} businessId    - business the event belongs to
 * @param {object} payload       - { title, body, url }
 * @param {string} excludeUserId - actor, so they are not notified of their own action
 */
export const dispatchWebPushNotification = async (businessId, payload, excludeUserId = null) => {
  try {
    if (!initVapid()) return;

    const recipients = await User.find({
      status: 'active',
      'pushSubscriptions.0': { $exists: true },
      ...(excludeUserId ? { _id: { $ne: excludeUserId } } : {}),
      $or: [{ assignedBusinesses: businessId }, { role: { $in: await fullAccessRoleIds() } }]
    });

    const body = JSON.stringify({
      title: payload.title || 'Update',
      body: payload.body || 'You have a new update.',
      url: payload.url || '/dashboard'
    });

    await Promise.allSettled(
      recipients.flatMap(user =>
        user.pushSubscriptions.map(subscription =>
          webpush.sendNotification(subscription, body).catch(async err => {
            // 410 Gone / 404 Not Found mean the browser dropped the
            // subscription — prune it so the list does not rot.
            if (err.statusCode === 410 || err.statusCode === 404) {
              await User.updateOne(
                { _id: user._id },
                { $pull: { pushSubscriptions: { endpoint: subscription.endpoint } } }
              ).catch(() => {});
            }
          })
        )
      )
    );
  } catch (error) {
    // Notifications are never allowed to fail the request that triggered them.
    logger.error({ err: error }, 'push notification dispatch error');
  }
};
