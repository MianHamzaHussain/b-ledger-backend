import ShopifyConnection from '../../models/ShopifyConnection.js';
import ShopifyApp from '../../models/ShopifyApp.js';
import { appCredentials } from './oauth.js';
import { decryptSecret, encryptSecret } from '../secretBox.js';

/**
 * The only place that talks to Shopify. `shopifyDeps.fetchImpl` is the single door to the network, so a test (or
 * a demo) replaces it and can never reach a real store. Shopify's own words for an error are turned into plain
 * ones a shop owner can act on.
 *
 * Auth is the client-credentials grant: the app's Client ID and secret are exchanged for a token that lasts 24
 * hours. It works when the app and the store belong to the same Shopify organization (Shopify's own rule).
 */
export const shopifyDeps = { fetchImpl: (...args) => fetch(...args) };

export const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';
const TIMEOUT_MS = 20_000;
/** Renew the token when less than this is left, so a long sync never starts with a token about to die. */
const RENEW_BEFORE_MS = 10 * 60 * 1000;

export class ShopifyError extends Error {
  constructor(message, { status, retryable = false, reconnect = false } = {}) {
    super(message);
    this.name = 'ShopifyError';
    this.statusCode = status ?? 502;
    this.retryable = retryable;
    /** The saved connection can no longer work (store removed the app, or the refresh token ran out): connect again. */
    this.reconnect = reconnect;
  }
}

/** A store address as people write it — "https://4fguhm-z1.myshopify.com/" — down to its subdomain. */
export const cleanShop = value =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\.myshopify\.com.*$/, '')
    .replace(/\/.*$/, '');

export const send = async (url, init) => {
  try {
    return await shopifyDeps.fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ShopifyError('Shopify could not be reached. Try again in a moment.', {
      retryable: true
    });
  }
};

/** Exchange the Client ID and secret for a 24-hour token — also the test that they are right. */
export const requestToken = async ({ shop, clientId, clientSecret }) => {
  const res = await send(`https://${shop}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    })
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok && body.access_token) {
    return {
      accessToken: body.access_token,
      expiresAt: new Date(Date.now() + (Number(body.expires_in) || 86_399) * 1000),
      scope: body.scope ?? ''
    };
  }
  const why = String(body.error_description ?? body.error ?? '');
  if (res.status === 404) {
    throw new ShopifyError(
      'Shopify does not know that store address. Use only the part before .myshopify.com (for admin.shopify.com/store/my-shop, that is my-shop).',
      { status: 400 }
    );
  }
  if (/shop_not_permitted/.test(why)) {
    throw new ShopifyError(
      'This app and the store are not in the same Shopify organization, so this way of connecting cannot be used for this store.',
      { status: 400 }
    );
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw new ShopifyError(
      'Shopify did not accept that Client ID and Client secret. Check that the ID and the secret are not swapped, and that the app is installed on this store.',
      { status: 400 }
    );
  }
  throw new ShopifyError('Shopify refused the request. Try again later.', {
    status: 502,
    retryable: res.status >= 500
  });
};

const NEEDS_RECONNECT = 'Shopify needs to be connected again. Press Reconnect.';

/** What Shopify's token answers hold, in the shape we save. */
const tokensFrom = body => ({
  accessToken: body.access_token,
  refreshToken: body.refresh_token,
  expiresAt: new Date(Date.now() + (Number(body.expires_in) || 3600) * 1000),
  refreshExpiresAt: new Date(
    Date.now() + (Number(body.refresh_token_expires_in) || 7_776_000) * 1000
  ),
  scope: body.scope ?? ''
});

const tokenRequest = async (shop, params) => {
  const res = await send(`https://${shop}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(params)
  });
  const body = await res.json().catch(() => ({}));
  return { res, body };
};

/**
 * Trade the one-time code Shopify sent back for the store's tokens (`expiring: 1` — Shopify requires tokens that expire).
 * The code is single use and lasts moments, so a failure here means "start again", never "retry".
 */
export const exchangeCode = async ({ shop, creds, code }) => {
  const { res, body } = await tokenRequest(shop, {
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    code,
    expiring: 1
  });
  if (res.ok && body.access_token && body.refresh_token) return tokensFrom(body);
  throw new ShopifyError('Shopify did not finish the connection. Please try again.', {
    status: res.status >= 500 ? 502 : 400,
    retryable: res.status >= 500
  });
};

/** Renew the access token from the refresh token. Shopify returns a NEW refresh token too: both must be saved. */
export const refreshAccessToken = async ({ connection, refreshToken }) => {
  const own = await ShopifyApp.findOne({ business: connection.business }).select(
    '+clientSecretEnc'
  );
  const creds = appCredentials(own);
  const { res, body } = await tokenRequest(connection.shop, {
    grant_type: 'refresh_token',
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: refreshToken
  });
  if (res.ok && body.access_token && body.refresh_token) return tokensFrom(body);
  // The store removed the app, or the refresh token expired (90 days): nothing can renew it — connect again.
  if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) {
    throw new ShopifyError(NEEDS_RECONNECT, { status: 400, reconnect: true });
  }
  throw new ShopifyError('Shopify is busy. It will be tried again shortly.', { retryable: true });
};

/** One renewal per store at a time inside this process; the conditional write below covers the rest (backend §10.8). */
const renewing = new Map();

/**
 * A working token for a one-click (`oauth`) connection. The access token lasts an hour, so it is renewed from the refresh
 * token shortly before it ends. Shopify rotates the refresh token on every renewal, so the new pair is saved together in ONE
 * conditional write (only if nobody renewed since we read it); if we lost that race, the winner's token is used.
 */
const oauthToken = async id => {
  const read = () => ShopifyConnection.findById(id).select('+accessTokenEnc +refreshTokenEnc');
  const connection = await read();
  if (!connection?.isActive || !connection.refreshTokenEnc) {
    throw new ShopifyError(NEEDS_RECONNECT, { status: 400, reconnect: true });
  }
  const left = connection.tokenExpiresAt ? connection.tokenExpiresAt.getTime() - Date.now() : 0;
  if (connection.accessTokenEnc && left > RENEW_BEFORE_MS) {
    return decryptSecret(connection.accessTokenEnc);
  }
  let fresh;
  try {
    fresh = await refreshAccessToken({
      connection,
      refreshToken: decryptSecret(connection.refreshTokenEnc)
    });
  } catch (err) {
    if (err.reconnect) {
      await ShopifyConnection.updateOne(
        { _id: id },
        { $set: { isActive: false, lastError: NEEDS_RECONNECT } }
      );
    }
    throw err;
  }
  const won = await ShopifyConnection.updateOne(
    { _id: id, tokenVersion: connection.tokenVersion ?? 0 },
    {
      $set: {
        accessTokenEnc: encryptSecret(fresh.accessToken),
        refreshTokenEnc: encryptSecret(fresh.refreshToken),
        tokenExpiresAt: fresh.expiresAt,
        refreshTokenExpiresAt: fresh.refreshExpiresAt
      },
      $inc: { tokenVersion: 1 }
    }
  );
  if (won.modifiedCount === 1) return fresh.accessToken;
  // Someone else renewed first: their pair is the live one now.
  const latest = await read();
  if (!latest?.accessTokenEnc) throw new ShopifyError(NEEDS_RECONNECT, { reconnect: true });
  return decryptSecret(latest.accessTokenEnc);
};

/**
 * A working token for a saved connection: the saved one while it has time left, otherwise a fresh one (saved
 * encrypted for the next call). `connection` must have been loaded with its secrets selected.
 */
export const tokenFor = async connection => {
  if (connection.authType === 'oauth') {
    const id = String(connection._id);
    if (!renewing.has(id))
      renewing.set(
        id,
        oauthToken(id).finally(() => renewing.delete(id))
      );
    return renewing.get(id);
  }
  const left = connection.tokenExpiresAt ? connection.tokenExpiresAt.getTime() - Date.now() : 0;
  if (connection.accessTokenEnc && left > RENEW_BEFORE_MS) {
    return decryptSecret(connection.accessTokenEnc);
  }
  const fresh = await requestToken({
    shop: connection.shop,
    clientId: connection.clientId,
    clientSecret: decryptSecret(connection.clientSecretEnc)
  });
  await ShopifyConnection.updateOne(
    { _id: connection._id },
    { $set: { accessTokenEnc: encryptSecret(fresh.accessToken), tokenExpiresAt: fresh.expiresAt } }
  );
  return fresh.accessToken;
};

/** Run one GraphQL query or mutation against the store. Returns Shopify's `data`; a problem is an error. */
export const graphql = async (connection, query, variables = {}) => {
  const token = await tokenFor(connection);
  const res = await send(
    `https://${connection.shop}.myshopify.com/admin/api/${API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables })
    }
  );
  const body = await res.json().catch(() => ({}));
  if (res.status === 429 || res.status >= 500) {
    throw new ShopifyError('Shopify is busy. It will be tried again shortly.', { retryable: true });
  }
  if (!res.ok || body.errors?.length) {
    // Shopify lists EVERY refused field in one answer: say them all, with the permission each needs, so a missing permission is
    // fixed once instead of one error at a time.
    const needs = [
      ...new Set((body.errors ?? []).map(e => e.extensions?.requiredAccess).filter(Boolean))
    ];
    const first = body.errors?.[0]?.message ?? `HTTP ${res.status}`;
    throw new ShopifyError(
      needs.length > 1
        ? `Shopify refused this app some fields. It needs: ${needs.join(' ')}`
        : `Shopify said: ${first}`,
      { status: 502 }
    );
  }
  return body.data;
};
