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
    clientId: { type: String, required: true, trim: true },
    clientSecretEnc: { type: String, select: false },
    accessTokenEnc: { type: String, select: false },
    tokenExpiresAt: { type: Date },
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

ShopifyConnectionSchema.index({ shop: 1 });

export default mongoose.model('ShopifyConnection', ShopifyConnectionSchema);
