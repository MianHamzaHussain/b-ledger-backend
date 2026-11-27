import ShopifyApp from '../models/ShopifyApp.js';
import ShopifyConnection from '../models/ShopifyConnection.js';
import ShopifyHold from '../models/ShopifyHold.js';
import ShopifyInstall from '../models/ShopifyInstall.js';
import ShopifyVariantLink from '../models/ShopifyVariantLink.js';
import logger from '../utils/logger.js';
import { notify } from '../utils/notify.js';
import { NOTIFICATION_TYPES } from '../utils/constants.js';
import { appCredentials, validShop, verifyWebhookHmac } from '../utils/shopify/oauth.js';
import { syncConnection } from '../utils/shopify/sync.js';

/**
 * Everything Shopify tells B Ledger's app by itself — one address for every store, declared once in the app's settings
 * (`shopify/shopify.app.toml`), not registered store by store. Shopify signs each call over the exact bytes it sent, with the app's
 * secret; anything that does not check out gets one and the same answer (401), which reveals nothing about which stores exist. Once the
 * signature is good the answer is an immediate 200 (Shopify waits only a few seconds) and the work follows. Nothing in a body is
 * trusted to say what to do: it only names a store, and what we do is decided by the topic and our own records.
 *
 *   orders/create             an order was placed — ask Shopify what is new (the usual import, which is safe to repeat)
 *   app/uninstalled           the owner removed the app — the connection stops, its tokens are forgotten, admins are told
 *   customers/data_request    a customer asked Shopify for their data — logged and a bell; a person answers within 30 days
 *   customers/redact          delete what we keep about that customer's orders on this store (the waiting holds)
 *   shop/redact               48 hours after uninstall — delete the connection, its holds and its variant links. Orders already
 *                             brought in STAY: they are the business's own records, like an order typed by hand
 *
 * @route  POST /api/v1/integrations/shopify/webhooks   (mounted before the JSON parser: it needs the raw bytes)
 */

const bodyOf = raw => {
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return {};
  }
};

/** The connection for a store: the active one, else the newest (an uninstalled one waits here for its redact). */
const connectionFor = shop =>
  ShopifyConnection.findOne({ shop }).sort({ isActive: -1, updatedAt: -1 });

const handle = async (topic, connection, payload) => {
  switch (topic) {
    case 'orders/create':
      if (connection?.isActive) await syncConnection(connection._id);
      return;

    case 'app/uninstalled':
      if (!connection) return;
      await ShopifyConnection.updateOne(
        { _id: connection._id },
        {
          $set: {
            isActive: false,
            uninstalledAt: new Date(),
            lastError:
              'Shopify was disconnected from this store. Press Reconnect to connect it again.'
          },
          $unset: { accessTokenEnc: 1, refreshTokenEnc: 1 }
        }
      );
      await notify({
        business: connection.business,
        type: NOTIFICATION_TYPES.SHOPIFY_ATTENTION,
        title: 'Shopify was disconnected',
        body: 'The app was removed from your Shopify store, so new orders will not come in until you connect it again.',
        link: '/integrations'
      });
      return;

    case 'customers/data_request':
      logger.info({ shop: connection?.shop }, 'shopify customer data request received');
      if (connection) {
        await notify({
          business: connection.business,
          type: NOTIFICATION_TYPES.SHOPIFY_ATTENTION,
          title: 'A customer asked for their data',
          body: 'Shopify forwarded a customer data request. An admin must answer it within 30 days.',
          link: '/integrations'
        });
      }
      return;

    case 'customers/redact': {
      if (!connection) return;
      const ids = (payload.orders_to_redact ?? []).map(String);
      if (ids.length) {
        await ShopifyHold.deleteMany({
          business: connection.business,
          shopifyOrderId: { $in: ids }
        });
      }
      return;
    }

    case 'shop/redact': {
      const rows = await ShopifyConnection.find({ shop: connection?.shop ?? payload.shop_domain });
      const businesses = rows.map(row => row.business);
      await ShopifyHold.deleteMany({ business: { $in: businesses } });
      await ShopifyVariantLink.deleteMany({ business: { $in: businesses } });
      await ShopifyConnection.deleteMany({ _id: { $in: rows.map(row => row._id) } });
      if (connection?.shop) await ShopifyInstall.deleteMany({ shop: connection.shop });
      return;
    }

    default:
  }
};

export const receiveAppWebhook = async (req, res) => {
  try {
    const shop = validShop(req.get('X-Shopify-Shop-Domain'));
    if (!shop || !Buffer.isBuffer(req.body)) return res.status(401).end();

    const connection = await connectionFor(shop);
    const own = connection
      ? await ShopifyApp.findOne({ business: connection.business }).select('+clientSecretEnc')
      : null;
    const { clientSecret } = appCredentials(own);
    if (!verifyWebhookHmac(req.body, req.get('X-Shopify-Hmac-Sha256'), clientSecret)) {
      return res.status(401).end();
    }

    res.status(200).end();
    await handle(req.get('X-Shopify-Topic') ?? '', connection, bodyOf(req.body));
  } catch (err) {
    logger.error({ err: err.message }, 'shopify app webhook failed');
    if (!res.headersSent) res.status(401).end();
  }
};
