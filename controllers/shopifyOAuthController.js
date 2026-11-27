import ShopifyApp from '../models/ShopifyApp.js';
import ShopifyConnection from '../models/ShopifyConnection.js';
import ShopifyInstall from '../models/ShopifyInstall.js';
import User from '../models/User.js';
import asyncHandler from '../middlewares/asyncHandler.js';
import ErrorResponse from '../utils/errorResponse.js';
import logger from '../utils/logger.js';
import { decryptSecret, encryptSecret } from '../utils/secretBox.js';
import { exchangeCode } from '../utils/shopify/client.js';
import {
  assertBusinessInScope,
  assertStoreFree,
  InstallRefusal,
  mayConnect,
  saveOauthConnection
} from '../utils/shopify/connect.js';
import {
  appCredentials,
  authorizeUrl,
  frontUrl,
  grantedEnough,
  hashOf,
  publicApp,
  randomToken,
  validShop,
  verifyQueryHmac
} from '../utils/shopify/oauth.js';

/**
 * Connect Shopify with one click — B Ledger is a Shopify app (OAuth, Shopify's authorization-code flow), so a business owner
 * presses a button, approves on Shopify's own screen and is done: no keys, no IDs, no secrets.
 *
 * Two entrances, one ending:
 *   • from B Ledger, the usual way: a ticket → /oauth/begin (sets a short cookie saying which business) → Shopify's install
 *     link → Shopify's approval → /install (reads the cookie) → Shopify's approval → /oauth/callback → connected;
 *   • from Shopify with no cookie (our install link opened elsewhere, or Shopify's own review): the callback saves the approval
 *     as `pending` and sends the person to a page to choose the business → /oauth/claim.
 * Also: "type your store address" (/oauth/start), the fallback when a cookie cannot be used.
 *
 * Every page the browser lands on (begin, install, callback) answers with a redirect back into the web app — never a raw error
 * page — and every request that arrives from Shopify is checked against Shopify's signature before anything else happens.
 * Nothing secret (code, state, ticket, token) is ever logged.
 *
 * @route  POST /api/v1/integrations/shopify/oauth/ticket   (integrations:update)
 * @route  GET  /api/v1/integrations/shopify/oauth/begin    (public: a one-time ticket)
 * @route  POST /api/v1/integrations/shopify/oauth/start    (integrations:update)
 * @route  GET  /api/v1/integrations/shopify/install        (public: Shopify's signature) — the app's "App URL"
 * @route  GET  /api/v1/integrations/shopify/oauth/callback (public: Shopify's signature + our state)
 * @route  GET  /api/v1/integrations/shopify/oauth/pending  (integrations:update)
 * @route  POST /api/v1/integrations/shopify/oauth/claim    (integrations:update)
 * @route  PUT  /api/v1/integrations/shopify/app            (Admin only)
 */

const COOKIE = 'bl_shopify';
const TICKET_MS = 2 * 60 * 1000;
const TRIP_MS = 10 * 60 * 1000;
const PENDING_MS = 60 * 60 * 1000;
const NOT_READY = 'Shopify connection is not set up on this server yet';

const apiBase = () => String(process.env.API_PUBLIC_URL ?? '').replace(/\/$/, '');
const cookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV !== 'development',
  sameSite: 'lax',
  path: '/api/v1/integrations/shopify'
});

/** Back into the web app, with a result the screen turns into a sentence. */
const toApp = (res, query) => {
  const text = new URLSearchParams(query).toString();
  return res.redirect(frontUrl(`/integrations${text ? `?${text}` : ''}`));
};
const fail = (res, reason) => toApp(res, { shopify: 'error', reason });

/** The business's own app when an admin set one up, loaded with its secret. */
const ownApp = business =>
  business ? ShopifyApp.findOne({ business }).select('+clientSecretEnc') : null;

const credsFor = async business => appCredentials(await ownApp(business));

/** Is the app this business would use ready? (Its Client ID, secret, the public address, and — to start from B Ledger — its install link.) */
const ready = (creds, { needsInstallUrl }) =>
  Boolean(
    creds.clientId &&
    creds.clientSecret &&
    process.env.API_PUBLIC_URL &&
    (!needsInstallUrl || creds.installUrl)
  );

/** The main button: a ticket the browser trades for the cookie one step later. */
export const createTicket = asyncHandler(async (req, res) => {
  const { business } = req.body;
  assertBusinessInScope(req, business);
  const creds = await credsFor(business);
  if (!ready(creds, { needsInstallUrl: true })) throw new ErrorResponse(NOT_READY, 503);

  const ticket = randomToken();
  await ShopifyInstall.create({
    kind: 'start',
    business,
    user: req.user.id,
    ticketHash: hashOf(ticket),
    expiresAt: new Date(Date.now() + TICKET_MS)
  });
  res.status(200).json({
    success: true,
    data: { url: `${apiBase()}/api/v1/integrations/shopify/oauth/begin?ticket=${ticket}` }
  });
});

/**
 * The browser arrives from the button. Setting the cookie here — a top-level page on our own address — is what lets it survive
 * Shopify's screens and come back with the install. The ticket is burned in the same step, so a link can be used once.
 */
export const beginInstall = async (req, res) => {
  try {
    const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : '';
    if (!ticket) return fail(res, 'expired');
    const cookie = randomToken();
    const install = await ShopifyInstall.findOneAndUpdate(
      { kind: 'start', ticketHash: hashOf(ticket), expiresAt: { $gt: new Date() } },
      {
        $unset: { ticketHash: 1 },
        $set: { cookieHash: hashOf(cookie), expiresAt: new Date(Date.now() + TRIP_MS) }
      },
      { returnDocument: 'after' }
    );
    if (!install) return fail(res, 'expired');
    const creds = await credsFor(install.business);
    if (!ready(creds, { needsInstallUrl: true })) return fail(res, 'notready');
    res.cookie(COOKIE, cookie, { ...cookieOptions(), maxAge: TRIP_MS });
    return res.redirect(creds.installUrl);
  } catch (err) {
    logger.error({ err }, 'shopify begin failed');
    return fail(res, 'failed');
  }
};

/** "Or type your store address": no cookie needed — the business travels in our own record, tied to the `state`. */
export const startByShop = asyncHandler(async (req, res) => {
  const { business } = req.body;
  assertBusinessInScope(req, business);
  const shop = validShop(req.body.shop);
  if (!shop) {
    throw new ErrorResponse('Enter your store address, like mystore.myshopify.com', 400);
  }
  const creds = await credsFor(business);
  if (!ready(creds, { needsInstallUrl: false })) throw new ErrorResponse(NOT_READY, 503);
  try {
    await assertStoreFree(shop, business);
  } catch (err) {
    throw new ErrorResponse(err.message, 400);
  }

  const state = randomToken();
  await ShopifyInstall.create({
    kind: 'start',
    business,
    user: req.user.id,
    shop,
    stateHash: hashOf(state),
    expiresAt: new Date(Date.now() + TRIP_MS)
  });
  res.status(200).json({
    success: true,
    data: { url: authorizeUrl({ shop, clientId: creds.clientId, state }) }
  });
});

/**
 * Shopify sends the browser here (the app's "App URL") when someone presses Install. The signature is checked first. The cookie
 * from /oauth/begin says which business began it; without one, the approval will wait for the person to choose.
 */
export const installLanding = async (req, res) => {
  try {
    const shop = validShop(req.query.shop);
    if (!shop) return fail(res, 'invalid');
    const cookie = typeof req.cookies?.[COOKIE] === 'string' ? req.cookies[COOKIE] : '';
    let install = cookie
      ? await ShopifyInstall.findOne({
          kind: 'start',
          cookieHash: hashOf(cookie),
          expiresAt: { $gt: new Date() }
        })
      : null;

    // The signature must be from the app this trip began with (the business's own, or ours).
    let creds = await credsFor(install?.business);
    if (!verifyQueryHmac(req.query, creds.clientSecret)) {
      const fallback = publicApp();
      if (creds.own && verifyQueryHmac(req.query, fallback.clientSecret)) {
        // The trip was for a business's own app, but this install came through ours: the cookie is not for it.
        install = null;
        creds = fallback;
      } else {
        return fail(res, 'invalid');
      }
    }
    if (!creds.clientId) return fail(res, 'notready');

    // Opened from Shopify's own admin by a store that is already connected: nothing to do but show it.
    const connected = await ShopifyConnection.exists({ shop, isActive: true });
    if (connected && !install) return toApp(res, {});

    const state = randomToken();
    if (install) {
      await ShopifyInstall.updateOne(
        { _id: install._id },
        {
          $set: {
            shop,
            stateHash: hashOf(state),
            expiresAt: new Date(Date.now() + TRIP_MS)
          },
          $unset: { cookieHash: 1 }
        }
      );
    } else {
      await ShopifyInstall.create({
        kind: 'start',
        shop,
        stateHash: hashOf(state),
        expiresAt: new Date(Date.now() + TRIP_MS)
      });
    }
    res.clearCookie(COOKIE, cookieOptions());
    return res.redirect(authorizeUrl({ shop, clientId: creds.clientId, state }));
  } catch (err) {
    logger.error({ err }, 'shopify install landing failed');
    return fail(res, 'failed');
  }
};

/**
 * Shopify sends the browser back after the owner approved. Order of checks: our record of the trip (the `state`), then
 * Shopify's signature, then the code is traded for tokens. The record is deleted before the trade — a state works once.
 */
export const oauthCallback = async (req, res) => {
  try {
    const shop = validShop(req.query.shop);
    const { code, state } = req.query;
    if (!shop || typeof code !== 'string' || typeof state !== 'string') return fail(res, 'invalid');

    const install = await ShopifyInstall.findOne({
      kind: 'start',
      stateHash: hashOf(state),
      expiresAt: { $gt: new Date() }
    });
    if (!install) return fail(res, 'expired');
    const creds = await credsFor(install.business);
    if (!verifyQueryHmac(req.query, creds.clientSecret)) return fail(res, 'invalid');
    if (install.shop && install.shop !== shop) return fail(res, 'invalid');

    const burned = await ShopifyInstall.findOneAndDelete({ _id: install._id });
    if (!burned) return fail(res, 'expired');

    const tokens = await exchangeCode({ shop, creds, code });
    if (!grantedEnough(tokens.scope)) return fail(res, 'denied');

    if (install.business) {
      // Minutes have passed: the person must still be allowed to do this for this business.
      const user = await User.findById(install.user).populate('role');
      if (!mayConnect(user, install.business)) return fail(res, 'permission');
      await saveOauthConnection({
        business: install.business,
        shop,
        tokens,
        userId: user._id
      });
      return toApp(res, { shopify: 'connected' });
    }

    // Began on Shopify, no business yet: keep the approval for an hour and let the person choose.
    const ticket = randomToken();
    await ShopifyInstall.create({
      kind: 'pending',
      shop,
      stateHash: hashOf(ticket),
      accessTokenEnc: encryptSecret(tokens.accessToken),
      refreshTokenEnc: encryptSecret(tokens.refreshToken),
      tokenExpiresAt: tokens.expiresAt,
      refreshTokenExpiresAt: tokens.refreshExpiresAt,
      scopes: tokens.scope,
      expiresAt: new Date(Date.now() + PENDING_MS)
    });
    return res.redirect(frontUrl(`/integrations/shopify/finish?ticket=${ticket}`));
  } catch (err) {
    if (err instanceof InstallRefusal) return fail(res, err.reason);
    logger.error({ err: err.message }, 'shopify callback failed');
    return fail(res, 'failed');
  }
};

/** The finish page asks which store is waiting. Never the tokens — only its address. */
export const getPending = asyncHandler(async (req, res) => {
  const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : '';
  const install = await ShopifyInstall.findOne({
    kind: 'pending',
    stateHash: hashOf(ticket),
    expiresAt: { $gt: new Date() }
  }).select('shop');
  if (!install)
    throw new ErrorResponse('That link has expired. Start again from Integrations.', 400);
  res.status(200).json({ success: true, data: { shop: install.shop } });
});

/** The person chose the business for an install that began on Shopify. */
export const claimInstall = asyncHandler(async (req, res) => {
  const { ticket, business } = req.body;
  assertBusinessInScope(req, business);
  const expired = new ErrorResponse('That link has expired. Start again from Integrations.', 400);

  const waiting = await ShopifyInstall.findOne({
    kind: 'pending',
    stateHash: hashOf(ticket),
    expiresAt: { $gt: new Date() }
  }).select('shop');
  if (!waiting) throw expired;
  try {
    await assertStoreFree(waiting.shop, business);
  } catch (err) {
    throw new ErrorResponse(err.message, 400);
  }

  // Used once: whoever deletes it first is the one that connects.
  const install = await ShopifyInstall.findOneAndDelete({
    _id: waiting._id,
    kind: 'pending'
  }).select('+accessTokenEnc +refreshTokenEnc');
  if (!install) throw expired;

  try {
    const saved = await saveOauthConnection({
      business,
      shop: install.shop,
      tokens: {
        accessToken: decryptSecret(install.accessTokenEnc),
        refreshToken: decryptSecret(install.refreshTokenEnc),
        expiresAt: install.tokenExpiresAt,
        refreshExpiresAt: install.refreshTokenExpiresAt,
        scope: install.scopes
      },
      userId: req.user.id
    });
    res.status(200).json({
      success: true,
      data: { shop: saved.shop, shopName: saved.shopName ?? null }
    });
  } catch (err) {
    if (err instanceof InstallRefusal) throw new ErrorResponse(err.message, 400);
    throw err;
  }
});

/**
 * Admin only: give a business a Shopify app of its own (custom distribution — no Shopify review), for a store that B Ledger's
 * public app cannot serve. The secret is saved encrypted and never returned.
 */
export const setOwnApp = asyncHandler(async (req, res) => {
  if (!req.user.role?.fullAccess) throw new ErrorResponse('Only an admin can do this', 403);
  const { business, clientId, clientSecret, installUrl } = req.body;
  await ShopifyApp.findOneAndUpdate(
    { business },
    {
      $set: {
        clientId,
        clientSecretEnc: encryptSecret(clientSecret),
        installUrl,
        updatedBy: req.user.id
      },
      $setOnInsert: { createdBy: req.user.id }
    },
    { upsert: true, setDefaultsOnInsert: true }
  );
  logger.info({ userId: req.user.id, business: String(business) }, 'shopify own app set');
  res.status(200).json({ success: true, data: { business, clientId, installUrl } });
});
