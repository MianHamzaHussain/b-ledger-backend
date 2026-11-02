import webpush from 'web-push';
import User from '../models/User.js';
import Business from '../models/Business.js';
import { fullAccessRoleIds } from './fullAccessRoles.js';
import logger from './logger.js';

let isVapidInitialized = false;

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
 * The text of one phone notification. For someone who works on more than one business the title starts with the
 * business ("Qam Style · New order #0122"), so a glance at the lock screen says where it comes from; someone with a
 * single business is spared the repetition. `business` rides along so a tap opens it in the right business.
 */
export const pushPayloadFor = ({ title, body, url, businessId, businessName, showBusiness }) => {
  const heading = title || 'Update';
  return JSON.stringify({
    title: showBusiness && businessName ? `${businessName} · ${heading}` : heading,
    body: body || 'You have a new update.',
    url: url || '/dashboard',
    business: String(businessId),
    businessName: businessName || undefined
  });
};

/** Does this person work on more than one business? (An Admin sees them all.) */
export const worksOnSeveral = (isAdmin, assignedCount, totalBusinesses) =>
  isAdmin ? totalBusinesses > 1 : assignedCount > 1;

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

    const adminRoles = await fullAccessRoleIds();
    const recipients = await User.find({
      status: 'active',
      'pushSubscriptions.0': { $exists: true },
      ...(excludeUserId ? { _id: { $ne: excludeUserId } } : {}),
      $or: [{ assignedBusinesses: businessId }, { role: { $in: adminRoles } }]
    });

    const business = await Business.findById(businessId).select('name');
    const totalBusinesses = await Business.countDocuments();
    const isAdminUser = user => adminRoles.some(id => String(id) === String(user.role));

    await Promise.allSettled(
      recipients.flatMap(user => {
        // Each person gets the wording that suits them: the business name only if they work on several.
        const body = pushPayloadFor({
          ...payload,
          businessId,
          businessName: business?.name?.trim(),
          showBusiness: worksOnSeveral(
            isAdminUser(user),
            user.assignedBusinesses?.length ?? 0,
            totalBusinesses
          )
        });
        return user.pushSubscriptions.map(subscription =>
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
        );
      })
    );
  } catch (error) {
    // Notifications are never allowed to fail the request that triggered them.
    logger.error({ err: error }, 'push notification dispatch error');
  }
};
