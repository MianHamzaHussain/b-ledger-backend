import crypto from 'node:crypto';
import ShopifyConnection from '../models/ShopifyConnection.js';
import ShopifyHold from '../models/ShopifyHold.js';
import ShopifyVariantLink from '../models/ShopifyVariantLink.js';
import Order from '../models/Order.js';
import Product from '../models/Product.js';
import asyncHandler from '../middlewares/asyncHandler.js';
import ErrorResponse from '../utils/errorResponse.js';
import logger from '../utils/logger.js';
import { decryptSecret, encryptSecret } from '../utils/secretBox.js';
import { cleanShop, graphql, requestToken } from '../utils/shopify/client.js';
import { retryHolds } from '../utils/shopify/importer.js';
import { actorFor, registerWebhook, syncConnection } from '../utils/shopify/sync.js';

/**
 * The Shopify connection of a business — one place to connect the store, see how it is doing, and fix the orders
 * that could not come in by themselves. Credentials go in once, are saved encrypted, and are never sent back.
 *
 * @route  GET    /api/v1/integrations/shopify?business=            (integrations:read — scoped)
 * @route  PUT    /api/v1/integrations/shopify                      (integrations:update)
 * @route  DELETE /api/v1/integrations/shopify?business=            (integrations:update)
 * @route  POST   /api/v1/integrations/shopify/sync                 (integrations:update, once a minute)
 * @route  GET    /api/v1/integrations/shopify/holds?business=      (integrations:read)
 * @route  POST   /api/v1/integrations/shopify/links                (integrations:update)
 * @route  POST   /api/v1/integrations/shopify/holds/:id/ignore     (integrations:update)
 */

/** A business outside the person's own is simply not found (the same rule as every scoped list). */
const assertInScope = (req, business) => {
  const allowed = req.accessFilter?.business?.$in;
  if (allowed && !allowed.map(String).includes(String(business))) {
    throw new ErrorResponse('Not found', 404);
  }
};

const view = async connection => {
  if (!connection) return { connected: false };
  const [imported, waiting] = await Promise.all([
    Order.countDocuments({ business: connection.business, shopifyOrderIds: { $exists: true } }),
    ShopifyHold.countDocuments({ business: connection.business, status: 'open' })
  ]);
  return {
    connected: true,
    shop: connection.shop,
    shopName: connection.shopName ?? null,
    clientId: connection.clientId,
    hasSecret: true,
    isActive: connection.isActive,
    goLiveAt: connection.goLiveAt,
    lastSyncAt: connection.lastSyncAt ?? null,
    lastError: connection.lastError ?? null,
    webhookActive: Boolean(connection.webhookActive),
    imported,
    waiting
  };
};

export const getShopify = asyncHandler(async (req, res) => {
  const { business } = req.query;
  if (!business) throw new ErrorResponse('Choose a business', 400);
  assertInScope(req, business);
  const connection = await ShopifyConnection.findOne({ business });
  res.status(200).json({ success: true, data: await view(connection) });
});

export const connectShopify = asyncHandler(async (req, res) => {
  const { business, clientId } = req.body;
  const shop = cleanShop(req.body.shop);
  assertInScope(req, business);

  const existing = await ShopifyConnection.findOne({ business }).select('+clientSecretEnc');
  const secret =
    req.body.clientSecret ??
    (existing?.clientSecretEnc ? decryptSecret(existing.clientSecretEnc) : '');
  if (!secret) throw new ErrorResponse('Enter the Client secret', 400);

  // Asking for a token is the test: it needs the right address, ID and secret, and the app installed on the store.
  const token = await requestToken({ shop, clientId, clientSecret: secret });

  const saved = await ShopifyConnection.findOneAndUpdate(
    { business },
    {
      $set: {
        shop,
        clientId,
        clientSecretEnc: encryptSecret(secret),
        accessTokenEnc: encryptSecret(token.accessToken),
        tokenExpiresAt: token.expiresAt,
        isActive: true,
        updatedBy: req.user.id
      },
      // Automation starts the day it is connected: older orders are never brought in.
      $setOnInsert: { goLiveAt: new Date(), createdBy: req.user.id },
      $unset: { lastError: 1 }
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  ).select('+clientSecretEnc +accessTokenEnc');

  try {
    const data = await graphql(saved, '{ shop { name } }');
    saved.shopName = data.shop?.name?.trim();
  } catch (err) {
    logger.warn({ err: err.message }, 'shopify shop name not read');
  }
  saved.webhookActive = await registerWebhook(saved);
  await saved.save();

  logger.info({ userId: req.user.id, business: String(business), shop }, 'shopify connected');
  res.status(200).json({ success: true, data: await view(saved) });
});

export const disconnectShopify = asyncHandler(async (req, res) => {
  const { business } = req.query;
  if (!business) throw new ErrorResponse('Choose a business', 400);
  assertInScope(req, business);
  // The orders already brought in stay; only the saved secret, token and the link go.
  await ShopifyConnection.deleteOne({ business });
  logger.info({ userId: req.user.id, business: String(business) }, 'shopify disconnected');
  res.status(200).json({ success: true, data: { connected: false } });
});

const syncedAt = new Map();
const COOLDOWN_MS = 60_000;
export const clearShopifyCooldown = () => syncedAt.clear();

export const syncNow = asyncHandler(async (req, res) => {
  const { business } = req.body;
  assertInScope(req, business);
  const connection = await ShopifyConnection.findOne({ business });
  if (!connection) throw new ErrorResponse('Shopify is not connected for this business', 400);

  const last = syncedAt.get(String(business));
  if (last && Date.now() - last < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - (Date.now() - last)) / 1000);
    throw new ErrorResponse(`Checked a moment ago — try again in ${wait} seconds`, 429);
  }
  syncedAt.set(String(business), Date.now());

  const tally = await syncConnection(connection._id, { retry: true });
  res.status(200).json({ success: true, data: tally });
});

export const listHolds = asyncHandler(async (req, res) => {
  const { business } = req.query;
  if (!business) throw new ErrorResponse('Choose a business', 400);
  assertInScope(req, business);
  const holds = await ShopifyHold.find({ business, status: 'open' })
    .select('-raw')
    .sort('shopifyCreatedAt');
  res.status(200).json({ success: true, count: holds.length, data: holds });
});

export const linkVariant = asyncHandler(async (req, res) => {
  const { business, shopifyVariantId, shopifyTitle, product, variantId } = req.body;
  assertInScope(req, business);

  const found = await Product.findOne({ _id: product, business, 'variants._id': variantId });
  if (!found) throw new ErrorResponse('That stock item is not in this business', 400);

  await ShopifyVariantLink.updateOne(
    { business, shopifyVariantId },
    { $set: { product, variantId, shopifyTitle, madeBy: 'person' } },
    { upsert: true }
  );

  // Everything that was waiting for this match can now go through.
  const connection = await ShopifyConnection.findOne({ business });
  const tally = connection
    ? await retryHolds(connection, await actorFor(connection))
    : { created: 0, merged: 0, held: 0, skipped: 0 };
  res.status(200).json({ success: true, data: tally });
});

export const ignoreHold = asyncHandler(async (req, res) => {
  const hold = await ShopifyHold.findById(req.params.id);
  if (!hold) throw new ErrorResponse('Not found', 404);
  assertInScope(req, hold.business);
  await ShopifyHold.updateOne(
    { _id: hold._id },
    { $set: { status: 'ignored', resolvedAt: new Date() }, $unset: { raw: 1 } }
  );
  res.status(200).json({ success: true, data: {} });
});

/**
 * Shopify says an order was placed. The call is signed with the app's Client secret over the exact bytes sent —
 * anything that does not check out gets one and the same answer, so it reveals nothing about which stores exist.
 * The call only means "ask Shopify what is new"; nothing in its body is trusted.
 *
 * @route  POST /api/v1/integrations/shopify/webhook   (mounted before the JSON parser: it needs the raw bytes)
 */
export const receiveShopifyWebhook = async (req, res) => {
  try {
    const shop = cleanShop(req.get('X-Shopify-Shop-Domain'));
    const signature = req.get('X-Shopify-Hmac-Sha256') ?? '';
    const connection = shop
      ? await ShopifyConnection.findOne({ shop, isActive: true }).select('+clientSecretEnc')
      : null;
    if (!connection || !Buffer.isBuffer(req.body)) return res.status(401).end();

    const expected = crypto
      .createHmac('sha256', decryptSecret(connection.clientSecretEnc))
      .update(req.body)
      .digest('base64');
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).end();

    // Answer quickly (Shopify waits only a few seconds), then do the work.
    res.status(200).end();
    await ShopifyConnection.updateOne({ _id: connection._id }, { $set: { webhookActive: true } });
    await syncConnection(connection._id);
  } catch (err) {
    logger.error({ err }, 'shopify webhook failed');
    if (!res.headersSent) res.status(401).end();
  }
};
