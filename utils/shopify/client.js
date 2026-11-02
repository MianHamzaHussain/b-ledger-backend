import ShopifyConnection from '../../models/ShopifyConnection.js';
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
  constructor(message, { status, retryable = false } = {}) {
    super(message);
    this.name = 'ShopifyError';
    this.statusCode = status ?? 502;
    this.retryable = retryable;
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

const send = async (url, init) => {
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

/**
 * A working token for a saved connection: the saved one while it has time left, otherwise a fresh one (saved
 * encrypted for the next call). `connection` must have been loaded with its secrets selected.
 */
export const tokenFor = async connection => {
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
    const first = body.errors?.[0]?.message ?? `HTTP ${res.status}`;
    throw new ShopifyError(`Shopify said: ${first}`, { status: 502 });
  }
  return body.data;
};
