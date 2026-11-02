import ShopifyConnection from '../../models/ShopifyConnection.js';
import User from '../../models/User.js';
import logger from '../logger.js';
import { graphql, ShopifyError } from './client.js';
import { importOrder, retryHolds } from './importer.js';

/**
 * Keep B Ledger's orders in step with the store. Shopify can tell us the moment an order is placed (a webhook), but
 * it is not guaranteed to — so every 10 minutes we also ASK for what was placed since last time (Shopify itself
 * recommends this). Both routes use the same code and bringing an order in is safe to repeat, so an order that
 * arrives by both is made once.
 */
const EVERY_MS = Math.max(Number(process.env.SHOPIFY_SYNC_SECONDS) || 10 * 60, 10) * 1000;
const PAGE = 50;
const MAX_PAGES = 10;
/** Look a little before the last check, so an order placed at that exact moment is never missed. */
const OVERLAP_MS = 10 * 60 * 1000;
/**
 * Once Shopify is telling us about every order (the webhook is set up), asking every 10 minutes is wasted work; the
 * question is kept hourly only as a safety net, because Shopify itself says a webhook can be missed.
 */
const SAFETY_MS = 60 * 60 * 1000;
/** Setting up the webhook is retried at most this often per store, so a refusal is not hammered. */
const WEBHOOK_RETRY_MS = 60 * 60 * 1000;
const webhookTried = new Map();

const status = {
  lastRunAt: null,
  lastChecked: 0,
  lastCreated: 0,
  lastMerged: 0,
  lastHeld: 0,
  lastErrors: 0
};
export const shopifySyncStatus = () => ({ ...status });

const ORDERS = `
  query Orders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, sortKey: CREATED_AT, query: $query) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id name createdAt cancelledAt note phone displayFinancialStatus paymentGatewayNames
        currentTotalPriceSet { shopMoney { amount } }
        totalShippingPriceSet { shopMoney { amount } }
        totalDiscountsSet { shopMoney { amount } }
        customer { firstName lastName phone email }
        shippingAddress { name phone address1 address2 city province zip }
        lineItems(first: 50) {
          nodes { title variantTitle sku quantity originalUnitPriceSet { shopMoney { amount } } variant { id } product { id } }
        }
      }
    }
  }`;

/** Every order placed since `since`, oldest first, so a second order is seen after the first it may join. */
export const fetchOrdersSince = async (connection, since) => {
  const out = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = await graphql(connection, ORDERS, {
      first: PAGE,
      after,
      query: `created_at:>='${since.toISOString()}'`
    });
    out.push(...(data.orders?.nodes ?? []));
    if (!data.orders?.pageInfo?.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  }
  return out.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
};

/** The person the new orders are made "by": whoever connected the store (they must still be active). */
export const actorFor = async connection => {
  const user = await User.findById(connection.createdBy).populate('role');
  if (!user || user.status !== 'active') {
    throw new ShopifyError('The person who connected Shopify is no longer active. Reconnect it.', {
      status: 400
    });
  }
  return user;
};

const running = new Set();
const withSecrets = id => ShopifyConnection.findById(id).select('+clientSecretEnc +accessTokenEnc');

/**
 * Ask Shopify for new orders and bring them in. One pass per store at a time (a webhook arriving mid-pass just
 * waits for the next one). Returns the tally; a failure is remembered on the connection and shown to people.
 */
export const syncConnection = async (connectionOrId, { retry = false } = {}) => {
  const id = String(connectionOrId._id ?? connectionOrId);
  if (running.has(id)) return { skipped: true };
  running.add(id);
  const tally = { checked: 0, created: 0, merged: 0, held: 0, skipped: 0, errors: 0 };
  try {
    const connection = await withSecrets(id);
    if (!connection?.isActive) return tally;
    await ensureWebhook(connection);
    const startedAt = new Date();
    try {
      const actor = await actorFor(connection);
      const since = connection.lastSyncAt
        ? new Date(connection.lastSyncAt.getTime() - OVERLAP_MS)
        : connection.goLiveAt;

      for (const node of await fetchOrdersSince(connection, since)) {
        tally.checked += 1;
        try {
          const { result } = await importOrder(connection, node, actor);
          tally[result] += 1;
        } catch (err) {
          tally.errors += 1;
          logger.error({ err, shopifyOrder: node.id }, 'shopify order could not be brought in');
        }
      }
      if (retry) {
        const again = await retryHolds(connection, actor);
        tally.created += again.created;
        tally.merged += again.merged;
      }
      await ShopifyConnection.updateOne(
        { _id: connection._id },
        { $set: { lastSyncAt: startedAt }, $unset: { lastError: 1 } }
      );
    } catch (err) {
      tally.errors += 1;
      await ShopifyConnection.updateOne(
        { _id: connection._id },
        { $set: { lastError: err.message } }
      );
      logger.warn({ shop: connection.shop, err: err.message }, 'shopify sync failed');
    }
    return tally;
  } finally {
    running.delete(id);
  }
};

/** One pass over every connected store (or one business's). */
export const runShopifySync = async ({ business = null } = {}) => {
  const connections = await ShopifyConnection.find({
    isActive: true,
    ...(business ? { business } : {})
  }).select('_id webhookActive lastSyncAt');
  // A store the webhook covers is only double-checked hourly; one without a webhook is asked every pass. Asking for
  // one business ("Check now") always asks.
  const due = c =>
    Boolean(business) ||
    !c.webhookActive ||
    !c.lastSyncAt ||
    Date.now() - c.lastSyncAt.getTime() >= SAFETY_MS;
  const total = { checked: 0, created: 0, merged: 0, held: 0, skipped: 0, errors: 0 };
  for (const { _id } of connections.filter(due)) {
    const t = await syncConnection(_id);
    for (const key of Object.keys(total)) total[key] += t[key] ?? 0;
  }
  return total;
};

/**
 * Tell Shopify to ping us when an order is placed. Best effort: if it cannot be set up (no public address, or
 * Shopify refuses) the 10-minute check still brings every order in, only a little later.
 */
export const registerWebhook = async connection => {
  const base = process.env.API_PUBLIC_URL;
  if (!base) return false;
  try {
    const data = await graphql(
      connection,
      `
        mutation Hook($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
          webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
            webhookSubscription {
              id
            }
            userErrors {
              field
              message
            }
          }
        }
      `,
      {
        topic: 'ORDERS_CREATE',
        sub: {
          callbackUrl: `${base.replace(/\/$/, '')}/api/v1/integrations/shopify/webhook`,
          format: 'JSON'
        }
      }
    );
    const errors = data.webhookSubscriptionCreate?.userErrors ?? [];
    // "Already exists" is as good as created.
    return errors.length === 0 || errors.some(e => /already|taken|exist/i.test(e.message));
  } catch (err) {
    logger.warn({ shop: connection.shop, err: err.message }, 'shopify webhook not registered');
    return false;
  }
};

/**
 * Set the webhook up when it is not yet — so adding `API_PUBLIC_URL` later, or a refusal that has since cleared, needs
 * no one to reconnect. Quiet and cheap: nothing happens without a public address, and a failure waits an hour.
 */
const ensureWebhook = async connection => {
  if (connection.webhookActive || !process.env.API_PUBLIC_URL) return;
  const last = webhookTried.get(String(connection._id));
  if (last && Date.now() - last < WEBHOOK_RETRY_MS) return;
  webhookTried.set(String(connection._id), Date.now());
  if (await registerWebhook(connection)) {
    await ShopifyConnection.updateOne({ _id: connection._id }, { $set: { webhookActive: true } });
    connection.webhookActive = true;
  }
};

export const clearWebhookRetry = () => webhookTried.clear();

/** Run now and then every 10 minutes; never overlaps itself, never takes the server down. */
export const startShopifySync = ({ everyMs = EVERY_MS } = {}) => {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const t = await runShopifySync();
      Object.assign(status, {
        lastRunAt: new Date().toISOString(),
        lastChecked: t.checked,
        lastCreated: t.created,
        lastMerged: t.merged,
        lastHeld: t.held,
        lastErrors: t.errors
      });
      if (t.created || t.merged || t.held) logger.info(t, 'shopify sync');
    } catch (err) {
      logger.error({ err }, 'shopify sync failed');
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return () => clearInterval(timer);
};
