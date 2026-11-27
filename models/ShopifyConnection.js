import mongoose from 'mongoose';

/**
 * A business's link to its Shopify store. One per business. The Client ID is not secret; the Client secret and the
 * access token are saved encrypted (utils/secretBox.js), hidden from every normal read, and never returned by any
 * endpoint — only `hasSecret`. The token lasts 24 hours and is renewed from the id and secret when it is about to end.
 */
const ShopifyConnectionSchema = new mongoose.Schema(
  {
    business: {
      type: mongoose.Schema.ObjectId,
      ref: 'Business',
      required: true,
      unique: true
    },
    /** The store's myshopify subdomain only, e.g. "4fguhm-z1" (not the shop's own web address). */
    shop: { type: String, required: true, trim: true, lowercase: true },
    /** The store's name as Shopify reports it, for display. */
    shopName: { type: String, trim: true },
    /**
     * How it was connected. `client-credentials`: the business made its own Shopify app and typed its Client ID and secret
     * (the old way, kept until every business has moved). `oauth`: B Ledger's own Shopify app was installed with one click —
     * no keys, and the tokens expire (an hour) and are renewed from a refresh token (90 days).
     */
    authType: {
      type: String,
      enum: ['client-credentials', 'oauth'],
      default: 'client-credentials'
    },
    clientId: {
      type: String,
      trim: true,
      required: [
        function needsClientId() {
          return this.authType !== 'oauth';
        },
        'Enter the Client ID'
      ]
    },
    clientSecretEnc: { type: String, select: false },
    accessTokenEnc: { type: String, select: false },
    tokenExpiresAt: { type: Date },
    /** oauth only: renews the access token. Rotates on every renewal, so the pair is always saved together. */
    refreshTokenEnc: { type: String, select: false },
    refreshTokenExpiresAt: { type: Date },
    /** Counts renewals: a renewal only lands if nobody else renewed first, so two never overwrite one another. */
    tokenVersion: { type: Number, default: 0 },
    /** What the store allowed (`read_orders,read_customers,read_products`). */
    scopes: { type: String },
    /** Set when Shopify says the app was removed from the store; the connection then waits to be redacted or reconnected. */
    uninstalledAt: { type: Date },

    isActive: { type: Boolean, default: true },
    /** Orders placed before this moment are never brought in: automation starts the day it is connected. */
    goLiveAt: { type: Date, required: true },
    /** When Shopify was last asked for new orders, and what went wrong if it could not be. */
    lastSyncAt: { type: Date },
    lastError: { type: String },
    /** Has Shopify been told to ping us the moment an order is placed? (Otherwise we check every 10 minutes.) */
    webhookActive: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.ObjectId, ref: 'User', required: true }
  },
  { timestamps: true }
);

// One store belongs to one business at a time. (A disconnected or removed connection no longer holds the store.)
ShopifyConnectionSchema.index(
  { shop: 1 },
  { unique: true, partialFilterExpression: { isActive: true }, name: 'shop_active_unique' }
);

export default mongoose.model('ShopifyConnection', ShopifyConnectionSchema);
