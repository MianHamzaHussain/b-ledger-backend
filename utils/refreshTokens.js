import crypto from 'crypto';

import RefreshToken from '../models/RefreshToken.js';
import Session from '../models/Session.js';

/** Cookie name carrying the refresh token. httpOnly, so JS never reads it. */
export const REFRESH_COOKIE = 'refreshToken';

const EXPIRE_DAYS = Number(process.env.REFRESH_TOKEN_EXPIRE_DAYS) || 30;

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

/** How long a refresh token (and so a session) lives — shared with the Session TTL. */
export const refreshLifetimeMs = () => EXPIRE_DAYS * 24 * 60 * 60 * 1000;

/** Mint + persist a refresh token; return the plaintext (only ever set as a cookie). */
export const issueRefreshToken = async (userId, sessionId) => {
  const token = crypto.randomBytes(40).toString('hex');
  const expiresAt = new Date(Date.now() + refreshLifetimeMs());
  await RefreshToken.create({
    user: userId,
    session: sessionId,
    tokenHash: sha256(token),
    expiresAt
  });
  return { token, expiresAt };
};

/**
 * Consume a presented token and issue a fresh one (rotation). Returns
 * `{ userId, token, expiresAt }` on success, or `null` if the token is unknown
 * or expired — deleting the old row means a replay of it fails, which is the
 * reuse defence.
 */
export const rotateRefreshToken = async presented => {
  if (!presented) return null;
  // Consumed in ONE operation: find-then-delete let two requests carrying the same cookie both
  // win, which defeats the replay defence (backend §5.3.2 — mutate contended state atomically).
  const existing = await RefreshToken.findOneAndDelete({
    tokenHash: sha256(presented),
    expiresAt: { $gt: new Date() }
  });
  if (!existing) return null;
  const userId = existing.user;
  const sessionId = existing.session;
  const next = await issueRefreshToken(userId, sessionId);
  if (sessionId) {
    // Remember the consumed token so a later replay of it is recognised as a copied cookie.
    await Session.updateOne(
      { _id: sessionId },
      {
        $set: { expiresAt: next.expiresAt },
        $push: { previousHashes: { $each: [sha256(presented)], $slice: -5 } }
      }
    );
  }
  return { userId, sessionId, ...next };
};

/**
 * A refresh token that is unknown to the live table but matches one this device already
 * rotated is a **copy**: the real client moved on, so someone else holds the old cookie. Returns the
 * session it belonged to (the caller revokes it), or null for a token that is simply unknown.
 */
export const detectReuse = async presented => {
  if (!presented) return null;
  return Session.findOne({ previousHashes: sha256(presented) });
};

/** Tie an already-issued refresh token to a session (a legacy cookie adopted on its first refresh). */
export const attachSession = (token, sessionId) =>
  RefreshToken.updateOne({ tokenHash: sha256(token) }, { $set: { session: sessionId } });

/** Drop a specific refresh token (logout). Safe to call with undefined. */
export const revokeRefreshToken = async presented => {
  if (presented) await RefreshToken.deleteOne({ tokenHash: sha256(presented) });
};

/**
 * Drop every refresh token for a user (a password change or reset, a forced sign-out). Bumping
 * `tokenVersion` only kills access tokens (15 min); without this the other devices' cookies kept
 * minting new ones for up to 30 days, so a changed password did not actually sign them out.
 */
export const revokeAllForUser = userId => RefreshToken.deleteMany({ user: userId });

/**
 * Cookie options. httpOnly always; Secure + SameSite are tunable so a same-host
 * deploy uses `lax` while a cross-origin one sets `COOKIE_SAMESITE=none`
 * (which the browser requires to be paired with Secure). Scoped to the auth
 * routes so it isn't sent on every request.
 */
export const refreshCookieOptions = expiresAt => ({
  httpOnly: true,
  secure: process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production',
  sameSite: process.env.COOKIE_SAMESITE || 'lax',
  path: '/api/v1/auth',
  expires: expiresAt
});

/** Matching options for clearing the cookie — path must match to erase it. */
export const clearCookieOptions = () => ({
  httpOnly: true,
  secure: process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production',
  sameSite: process.env.COOKIE_SAMESITE || 'lax',
  path: '/api/v1/auth'
});
