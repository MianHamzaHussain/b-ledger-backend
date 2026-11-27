import mongoose from 'mongoose';

/**
 * A Shopify app made just for one business ("custom distribution": Shopify does not review it, and it is outside the App Store
 * rules). It is the fallback when B Ledger's own public app cannot be used for a store. Everything else — the one-click
 * connection, the expiring tokens, the webhooks — works exactly the same; only whose Client ID and secret are used changes.
 * Admin-only to set. The secret is saved encrypted (utils/secretBox.js), hidden from every normal read, and never returned.
 */
const ShopifyAppSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.ObjectId, ref: 'Business', required: true, unique: true },
    clientId: { type: String, required: true, trim: true },
    clientSecretEnc: { type: String, required: true, select: false },
    /** The install link the Dev Dashboard gives this app. */
    installUrl: { type: String, required: true, trim: true },
    createdBy: { type: mongoose.Schema.ObjectId, ref: 'User', required: true },
    updatedBy: { type: mongoose.Schema.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

export default mongoose.model('ShopifyApp', ShopifyAppSchema);
