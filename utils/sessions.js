import Session from '../models/Session.js';
import RefreshToken from '../models/RefreshToken.js';
import { describeDevice } from './userAgent.js';
import { refreshLifetimeMs } from './refreshTokens.js';

/**
 * Signed-in devices. A session is one row per device; the refresh token row(s) and the access token's
 * `sid` point at it, so removing the row here is what actually signs that device out.
 */

/** Browser, system, kind and address from a request — tolerant of a bare mock request. */
export const deviceFromRequest = req => ({
  ...describeDevice(req?.headers?.['user-agent']),
  ip: req?.ip || undefined
});

/** Start a session for a sign-in; returns the document (its `_id` goes into the tokens). */
export const createSession = (userId, req, extra = {}) =>
  Session.create({
    user: userId,
    ...deviceFromRequest(req),
    expiresAt: new Date(Date.now() + refreshLifetimeMs()),
    ...extra
  });

/** True while the session exists for this user — the check `protect` runs on every request. */
export const sessionIsLive = async (sessionId, userId) =>
  Boolean(await Session.exists({ _id: sessionId, user: userId }));

/** One write a minute per session at most — "last active" is a guide, not an audit trail. */
const WRITE_EVERY_MS = 60_000;
const lastTouched = new Map();
export const touchSession = (sessionId, req) => {
  const key = String(sessionId);
  const now = Date.now();
  if (now - (lastTouched.get(key) ?? 0) < WRITE_EVERY_MS) return;
  lastTouched.set(key, now);
  if (lastTouched.size > 5000) lastTouched.clear();
  const ip = req?.ip;
  Session.updateOne(
    { _id: sessionId },
    { $set: { lastActiveAt: new Date(), ...(ip ? { ip } : {}) } }
  ).catch(() => {});
};

/** The person's devices, the current one first, then the most recently used. */
export const listSessions = async (userId, currentSessionId) => {
  const rows = await Session.find({ user: userId }).sort({ lastActiveAt: -1 }).lean();
  const current = String(currentSessionId ?? '');
  return rows
    .map(s => ({
      _id: s._id,
      browser: s.browser,
      os: s.os,
      kind: s.kind,
      ip: s.ip,
      signedInAt: s.createdAt,
      lastActiveAt: s.lastActiveAt,
      isLegacy: Boolean(s.isLegacy),
      isCurrent: String(s._id) === current
    }))
    .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent));
};

/** Sign one device out. Returns false when it was not this user's (or already gone). */
export const revokeSession = async (userId, sessionId) => {
  const { deletedCount } = await Session.deleteOne({ _id: sessionId, user: userId });
  if (!deletedCount) return false;
  await RefreshToken.deleteMany({ user: userId, session: sessionId });
  return true;
};

/** Sign every device out except `keepSessionId` (leave undefined to sign out all of them). */
export const revokeOtherSessions = async (userId, keepSessionId) => {
  const keep = keepSessionId ? { _id: { $ne: keepSessionId } } : {};
  const doomed = await Session.find({ user: userId, ...keep })
    .select('_id')
    .lean();
  await Session.deleteMany({ user: userId, ...keep });
  const keepToken = keepSessionId ? { session: { $ne: keepSessionId } } : {};
  // Tokens of the doomed sessions, plus any left over from before sessions existed (no session id).
  await RefreshToken.deleteMany({ user: userId, ...keepToken });
  return doomed.length;
};
