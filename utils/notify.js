import Notification from '../models/Notification.js';
import { emitToBusiness } from './socket.js';
import { dispatchWebPushNotification } from './pushHelper.js';

/**
 * Raise an in-app notification. This is a **side effect** of a real action, so
 * it never throws — a failed alert must not fail the order that triggered it.
 *
 * Delivery is three-layered, each independent so one failing never loses the
 * alert:
 *   1. persisted (survives reload, drives the unread badge and history)
 *   2. Socket.io to the business room — instant, for tabs that are open
 *   3. Web Push to each subscribed device — reaches users with the app closed
 *
 * `isRead: false` is baked into the socket payload because a brand-new
 * notification is unread for every recipient — the client can toast it as-is.
 */
export const notify = async ({ business, type, title, body, link }) => {
  let doc;
  try {
    doc = await Notification.create({ business, type, title, body, link });
  } catch (err) {
    console.error('notify failed:', err.message);
    return null;
  }

  // Best-effort: if the socket layer is down, the persisted record still
  // surfaces on the next fetch, so a broken emit must not lose the alert.
  try {
    emitToBusiness(business, 'notification', {
      _id: doc._id,
      type: doc.type,
      title: doc.title,
      body: doc.body,
      link: doc.link,
      createdAt: doc.createdAt,
      isRead: false
    });
  } catch (err) {
    console.error('notify emit failed:', err.message);
  }

  // Fire-and-forget: web push fans out over the network to every device, so it
  // must never block or fail the action that triggered it. The helper swallows
  // its own errors and prunes dead subscriptions.
  dispatchWebPushNotification(business, { title, body, url: link });

  return doc;
};
