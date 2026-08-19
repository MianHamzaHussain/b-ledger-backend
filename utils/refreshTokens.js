import crypto from 'crypto';

import RefreshToken from '../models/RefreshToken.js';

/** Cookie name carrying the refresh token. httpOnly, so JS never reads it. */
export const REFRESH_COOKIE = 'refreshToken';

const EXPIRE_DAYS = Number(process.env.REFRESH_TOKEN_EXPIRE_DAYS) || 30;

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

/** Mint + persist a refresh token; return the plaintext (only ever set as a cookie). */
export const issueRefreshToken = async userId => {
  const token = crypto.randomBytes(40).toString('hex');
  const expiresAt = new Date(Date.now() + EXPIRE_DAYS * 24 * 60 * 60 * 1000);
  await RefreshToken.create({ user: userId, tokenHash: sha256(token), expiresAt });
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
  const existing = await RefreshToken.findOne({ tokenHash: sha256(presented) });
  if (!existing || existing.expiresAt < new Date()) return null;
  const userId = existing.user;
  await existing.deleteOne();
  const next = await issueRefreshToken(userId);
  return { userId, ...next };
};

/** Drop a specific refresh token (logout). Safe to call with undefined. */
export const revokeRefreshToken = async presented => {
  if (presented) await RefreshToken.deleteOne({ tokenHash: sha256(presented) });
};

/** Drop every refresh token for a user (e.g. forced sign-out). */
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
