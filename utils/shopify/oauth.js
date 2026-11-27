import crypto from 'node:crypto';
import { decryptSecret } from '../secretBox.js';

/**
 * The pure parts of "Connect Shopify" with one click: which app we are, how Shopify's signatures are checked, and how the
 * links are built. Nothing here touches the network or the database (the calls to Shopify live in client.js).
 *
 * B Ledger is ONE Shopify app that any store can install (the public app). Its Client ID and secret live only in the server's
 * environment. A business may instead have an app of its own ("custom distribution": no Shopify review) — its credentials are
 * saved on its connection, encrypted — and everything below works the same with either.
 */

/** The public app, from the server's environment. */
export const publicApp = () => ({
  clientId: String(process.env.SHOPIFY_API_KEY ?? '').trim(),
  clientSecret: String(process.env.SHOPIFY_API_SECRET ?? '').trim(),
  installUrl: String(process.env.SHOPIFY_INSTALL_URL ?? '').trim(),
  own: false
});

/**
 * The app a business uses: its own (a `ShopifyApp` row, loaded with its secret) when it has one, otherwise the public app.
 * `own` may be null.
 */
export const appCredentials = own => {
  if (own?.clientId && own.clientSecretEnc) {
    return {
      clientId: own.clientId,
      clientSecret: decryptSecret(own.clientSecretEnc),
      installUrl: own.installUrl ?? '',
      own: true
    };
  }
  return publicApp();
};

/** Is the public app set up on this server? (Without it the card says so and nothing crashes.) */
export const isConfigured = () => {
  const app = publicApp();
  return Boolean(app.clientId && app.clientSecret && process.env.API_PUBLIC_URL);
};

/** What B Ledger asks the store to allow. `read_orders` is the only thing it needs: it reads, and writes nothing. */
export const scopes = () => String(process.env.SHOPIFY_SCOPES || 'read_orders').trim();

/** The address Shopify sends the browser back to — it must match the one in the app's settings exactly. */
export const callbackUrl = () =>
  `${String(process.env.API_PUBLIC_URL ?? '').replace(/\/$/, '')}/api/v1/integrations/shopify/oauth/callback`;

/** The web app's address, where every trip ends. */
export const frontUrl = path =>
  `${String(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '')}${path}`;

/**
 * A store address as it must be before it is used in a link: the subdomain only, letters, digits and hyphens. Anything else
 * (a dot, a slash, an @, a port) is refused, so a crafted value can never point a request at another site.
 */
export const validShop = value => {
  const shop = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\.myshopify\.com.*$/, '')
    .replace(/\/.*$/, '');
  return /^[a-z0-9][a-z0-9-]{0,60}$/.test(shop) ? shop : null;
};

export const randomToken = () => crypto.randomBytes(32).toString('hex');
export const hashOf = value => crypto.createHash('sha256').update(String(value)).digest('hex');

const sameBytes = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * Shopify signs the query of every redirect to us: the parameters except `hmac`, sorted, joined as `key=value&…`, HMAC-SHA256
 * with the app's secret, in hex. A request older than five minutes is refused too, so a captured link cannot be replayed later.
 */
export const verifyQueryHmac = (query, secret) => {
  if (!secret || !query || typeof query.hmac !== 'string') return false;
  const entries = Object.entries(query).filter(([key]) => key !== 'hmac' && key !== 'signature');
  if (entries.some(([, value]) => typeof value !== 'string')) return false;
  const message = entries
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const expected = crypto.createHmac('sha256', secret).update(message).digest('hex');
  if (!sameBytes(query.hmac, expected)) return false;
  if (query.timestamp !== undefined) {
    const age = Math.abs(Date.now() / 1000 - Number(query.timestamp));
    if (!Number.isFinite(age) || age > 300) return false;
  }
  return true;
};

/** A webhook is signed over the exact bytes it sent (base64, in `X-Shopify-Hmac-Sha256`). */
export const verifyWebhookHmac = (rawBody, header, secret) => {
  if (!secret || !Buffer.isBuffer(rawBody) || !header) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  return sameBytes(header, expected);
};

/** Shopify's screen where the owner reviews what the app asks for and presses Install. */
export const authorizeUrl = ({ shop, clientId, state }) => {
  const query = new URLSearchParams({
    client_id: clientId,
    scope: scopes(),
    redirect_uri: callbackUrl(),
    state
  });
  return `https://${shop}.myshopify.com/admin/oauth/authorize?${query}`;
};

/** Did the store grant what we need? (An owner can untick permissions on some screens.) */
export const grantedEnough = granted => {
  const have = String(granted ?? '')
    .split(',')
    .map(part => part.trim());
  return scopes()
    .split(',')
    .every(want => have.includes(want.trim()));
};
