import ShopifyConnection from '../../models/ShopifyConnection.js';
import ErrorResponse from '../errorResponse.js';
import logger from '../logger.js';
import { encryptSecret } from '../secretBox.js';
import { resolvePermissions } from '../permissions.js';
import { graphql } from './client.js';

/**
 * Saving a one-click connection, and who may make one. Used by every way a store gets connected (the main button, the
 * "type your store address" box, and the finish page after an install that began on Shopify), so the rules live once.
 */

/** A refused trip, with a short code the web app turns into a sentence. */
export class InstallRefusal extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

/** A business outside the person's own is simply not found (the same rule as every scoped list). */
export const assertBusinessInScope = (req, business) => {
  const allowed = req.accessFilter?.business?.$in;
  if (allowed && !allowed.map(String).includes(String(business))) {
    throw new ErrorResponse('Not found', 404);
  }
};

/**
 * May this person connect Shopify for this business — checked again when Shopify sends the browser back, because minutes
 * have passed since the button was pressed and their access may have changed.
 */
export const mayConnect = (user, business) => {
  if (!user || user.status !== 'active') return false;
  if (user.role?.fullAccess) return true;
  const perm = resolvePermissions(user).get('integrations');
  if (!perm?.actions.has('update')) return false;
  return (
    perm.scope === 'all' || (user.assignedBusinesses ?? []).map(String).includes(String(business))
  );
};

const TAKEN = 'This store is already linked to another business in B Ledger';

/** A store belongs to one business at a time: refuse early (and kindly) when it is already linked to another one. */
export const assertStoreFree = async (shop, business) => {
  const taken = await ShopifyConnection.exists({
    shop,
    isActive: true,
    business: { $ne: business }
  });
  if (taken) throw new InstallRefusal('taken', TAKEN);
};

/**
 * Connect a store to a business with the tokens Shopify just gave. A business has one connection (a new one replaces the old,
 * keeping `goLiveAt`, so no earlier order is brought in twice), and a store belongs to one business at a time.
 */
export const saveOauthConnection = async ({ business, shop, tokens, userId }) => {
  await assertStoreFree(shop, business);
  let saved;
  try {
    saved = await ShopifyConnection.findOneAndUpdate(
      { business },
      {
        $set: {
          authType: 'oauth',
          shop,
          accessTokenEnc: encryptSecret(tokens.accessToken),
          refreshTokenEnc: encryptSecret(tokens.refreshToken),
          tokenExpiresAt: tokens.expiresAt,
          refreshTokenExpiresAt: tokens.refreshExpiresAt,
          scopes: tokens.scope,
          tokenVersion: 0,
          isActive: true,
          // The app's own webhooks (declared once for every store) bring orders in, so nothing is registered per store.
          webhookActive: true,
          createdBy: userId,
          updatedBy: userId
        },
        $unset: { clientId: 1, clientSecretEnc: 1, lastError: 1, uninstalledAt: 1 },
        // Automation starts the day it is connected: older orders are never brought in.
        $setOnInsert: { goLiveAt: new Date() }
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    ).select('+accessTokenEnc +refreshTokenEnc');
  } catch (err) {
    // Two people connecting the same store at the same moment: the database's unique index decides.
    if (err.code === 11000) throw new InstallRefusal('taken', TAKEN);
    throw err;
  }
  try {
    const data = await graphql(saved, '{ shop { name } }');
    const name = data.shop?.name?.trim();
    if (name) await ShopifyConnection.updateOne({ _id: saved._id }, { $set: { shopName: name } });
    saved.shopName = name;
  } catch (err) {
    logger.warn({ err: err.message }, 'shopify shop name not read');
  }
  logger.info({ userId: String(userId), business: String(business), shop }, 'shopify connected');
  return saved;
};
