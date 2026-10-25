import User from '../models/User.js';
import logger from './logger.js';

/**
 * Who is online right now, and when someone was last active.
 *
 * Online = at least one live socket. Several tabs or devices count once: the person goes online
 * with the first and offline when the last one closes. A closed socket does not flip them offline
 * straight away — a refresh or a patchy mobile network reconnects within seconds — so offline waits
 * a short grace period, and a reconnect inside it never shows as a change.
 *
 * "Last active" is a different fact (a tab left open overnight is connected but idle): it is the
 * last authenticated request (see `touchActive`), and the moment they went offline.
 *
 * In memory, which is exactly right for one API process (as deployed). Scaling out would need the
 * Socket.IO Redis adapter — noted under Known gaps.
 */
export const createPresence = ({ onChange, graceMs = 20_000 } = {}) => {
  const counts = new Map();
  const timers = new Map();

  return {
    connect(userId) {
      const id = String(userId);
      const pending = timers.get(id);
      if (pending) {
        // Came back inside the grace period: they never went offline.
        clearTimeout(pending);
        timers.delete(id);
        counts.set(id, (counts.get(id) ?? 0) + 1);
        return;
      }
      const wasOnline = (counts.get(id) ?? 0) > 0;
      counts.set(id, (counts.get(id) ?? 0) + 1);
      if (!wasOnline) onChange?.({ userId: id, online: true });
    },

    disconnect(userId) {
      const id = String(userId);
      const left = (counts.get(id) ?? 0) - 1;
      if (left > 0) return void counts.set(id, left);
      counts.set(id, 0);
      const timer = setTimeout(() => {
        timers.delete(id);
        counts.delete(id);
        onChange?.({ userId: id, online: false, lastActiveAt: new Date() });
      }, graceMs);
      timer.unref();
      timers.set(id, timer);
    },

    // Someone inside the grace period is still shown online — that is the point of it.
    onlineIds: () => [...counts.keys()].filter(id => (counts.get(id) ?? 0) > 0 || timers.has(id))
  };
};

/** One write a minute per person at most — activity is a rough "last seen", not an audit trail. */
const WRITE_EVERY_MS = 60_000;
const lastWrite = new Map();

/**
 * Note that this person just did something. Throttled in memory so a busy screen never writes on
 * every request; written without touching `updatedAt`, so it never looks like a profile edit.
 * Fire and forget: a failed write must never fail the request that triggered it.
 */
export const touchActive = (userId, now = Date.now()) => {
  const id = String(userId);
  if (now - (lastWrite.get(id) ?? 0) < WRITE_EVERY_MS) return;
  lastWrite.set(id, now);
  User.updateOne(
    { _id: id },
    { $set: { lastActiveAt: new Date(now) } },
    { timestamps: false }
  ).catch(err => logger.warn({ err }, 'last active not saved'));
};

/** Test helper: forget the throttle. */
export const resetTouchThrottle = () => lastWrite.clear();

/** Stamp the moment someone went offline — the last time they were around. */
export const stampLastActive = (userId, at) =>
  User.updateOne({ _id: userId }, { $set: { lastActiveAt: at } }, { timestamps: false }).catch(
    err => logger.warn({ err }, 'last active not saved')
  );
