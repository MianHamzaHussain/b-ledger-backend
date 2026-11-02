import express from 'express';
import { protect } from '../middlewares/auth.js';
import { can, restrictBusinessToScope } from '../middlewares/permissions.js';
import { validate } from '../middlewares/validate.js';
import {
  shopifyBusinessSchema,
  shopifyConnectSchema,
  shopifyLinkSchema
} from '../schemas/shopify.js';
import {
  connectShopify,
  disconnectShopify,
  getShopify,
  ignoreHold,
  linkVariant,
  listHolds,
  syncNow
} from '../controllers/shopifyController.js';

const router = express.Router();
router.use(protect);

/**
 * @swagger
 * /integrations/shopify:
 *   get:
 *     summary: How a business's Shopify store is connected (never the secret)
 *     tags: [Integrations]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: business, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: "{ connected: false } or the connection's state" }
 *   put:
 *     summary: Connect (or update) the store — the Client ID and secret are tested before anything is saved
 *     tags: [Integrations]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: The connection }
 *       400: { description: Shopify did not accept the address, ID or secret — in plain words }
 *   delete:
 *     summary: Disconnect the store and forget its secret; orders already brought in stay
 *     tags: [Integrations]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Disconnected }
 */
router
  .route('/')
  .get(can('integrations', 'read'), getShopify)
  .put(
    can('integrations', 'update'),
    restrictBusinessToScope(),
    validate(shopifyConnectSchema),
    connectShopify
  )
  .delete(can('integrations', 'update'), disconnectShopify);

/**
 * @swagger
 * /integrations/shopify/sync:
 *   post:
 *     summary: Ask Shopify for new orders now (once a minute per business)
 *     tags: [Integrations]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ checked, created, merged, held, skipped, errors }" }
 *       429: { description: Checked a moment ago }
 */
router.post(
  '/sync',
  can('integrations', 'update'),
  restrictBusinessToScope(),
  validate(shopifyBusinessSchema),
  syncNow
);

/**
 * @swagger
 * /integrations/shopify/holds:
 *   get:
 *     summary: Shopify orders waiting for a person, with the reason for each
 *     tags: [Integrations]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: The waiting orders }
 */
router.get('/holds', can('integrations', 'read'), listHolds);

/**
 * @swagger
 * /integrations/shopify/links:
 *   post:
 *     summary: Say which stock item a Shopify product size is; waiting orders then go through
 *     tags: [Integrations]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "What happened to the waiting orders" }
 */
router.post(
  '/links',
  can('integrations', 'update'),
  restrictBusinessToScope(),
  validate(shopifyLinkSchema),
  linkVariant
);

router.post('/holds/:id/ignore', can('integrations', 'update'), ignoreHold);

export default router;
