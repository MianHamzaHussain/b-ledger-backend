import express from 'express';
import rateLimit from 'express-rate-limit';
import { protect } from '../middlewares/auth.js';
import { can, restrictBusinessToScope } from '../middlewares/permissions.js';
import { validate } from '../middlewares/validate.js';
import {
  shopifyBusinessSchema,
  shopifyClaimSchema,
  shopifyConnectSchema,
  shopifyLinkSchema,
  shopifyOwnAppSchema,
  shopifyStartSchema
} from '../schemas/shopify.js';
import {
  beginInstall,
  claimInstall,
  createTicket,
  getPending,
  installLanding,
  oauthCallback,
  setOwnApp,
  startByShop
} from '../controllers/shopifyOAuthController.js';
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

/**
 * The three pages the browser lands on during "Connect Shopify". They are public — Shopify and the browser call them, not a signed-in
 * person — so each is protected by what it can check instead: a one-time ticket, Shopify's signature and our own single-use state.
 * They answer with redirects only, and a stricter limit than the rest of the API.
 */
const publicLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
});
router.get('/oauth/begin', publicLimit, beginInstall);
router.get('/install', publicLimit, installLanding);
router.get('/oauth/callback', publicLimit, oauthCallback);

router.use(protect);

/**
 * @swagger
 * /integrations/shopify/oauth/ticket:
 *   post:
 *     summary: Begin "Connect Shopify" — returns the address that opens Shopify (the browser follows it)
 *     tags: [Integrations]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ url }" }
 *       503: { description: The Shopify app is not set up on this server yet }
 * /integrations/shopify/oauth/start:
 *   post:
 *     summary: Begin "Connect Shopify" from a typed store address — returns Shopify's approval address
 *     tags: [Integrations]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ url }" }
 * /integrations/shopify/oauth/pending:
 *   get:
 *     summary: Which store is waiting to be linked (an install that began on Shopify)
 *     tags: [Integrations]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ shop }" }
 * /integrations/shopify/oauth/claim:
 *   post:
 *     summary: Link a waiting store to a business
 *     tags: [Integrations]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ shop, shopName }" }
 * /integrations/shopify/app:
 *   put:
 *     summary: Admin only — give a business a Shopify app of its own (custom distribution)
 *     tags: [Integrations]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Saved (the secret is never returned) }
 */
router.post(
  '/oauth/ticket',
  can('integrations', 'update'),
  restrictBusinessToScope(),
  validate(shopifyBusinessSchema),
  createTicket
);
router.post(
  '/oauth/start',
  can('integrations', 'update'),
  restrictBusinessToScope(),
  validate(shopifyStartSchema),
  startByShop
);
router.get('/oauth/pending', can('integrations', 'update'), getPending);
router.post(
  '/oauth/claim',
  can('integrations', 'update'),
  restrictBusinessToScope(),
  validate(shopifyClaimSchema),
  claimInstall
);
router.put(
  '/app',
  can('integrations', 'update'),
  restrictBusinessToScope(),
  validate(shopifyOwnAppSchema),
  setOwnApp
);

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
