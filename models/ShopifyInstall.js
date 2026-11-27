import mongoose from 'mongoose';

/**
 * One trip to Shopify and back, remembered for a few minutes. It ties the two halves of "Connect Shopify" together without
 * trusting the browser: B Ledger knows which business and which person began it, and Shopify's answer must carry back the
 * random `state` we made. Nothing secret is saved in the clear — the state, the ticket and the cookie value are kept only as
 * SHA-256 hashes, and the tokens (a `pending` install only) are encrypted. Single use: it is deleted when it is used, and a
 * TTL index sweeps what was never finished.
 *
 *   start    — begun from B Ledger (`business` + `user` set), or from Shopify with no business yet.
 *   pending  — Shopify approved but B Ledger does not yet know which business: waits for the person to choose.
 */
const ShopifyInstallSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['start', 'pending'], required: true },
    business: { type: mongoose.Schema.ObjectId, ref: 'Business' },
    user: { type: mongoose.Schema.ObjectId, ref: 'User' },
    shop: { type: String, trim: true, lowercase: true },
    /** The one-time ticket of the main button (`start`); burned when the browser arrives at /oauth/begin. */
    ticketHash: { type: String },
    /** The cookie that carries "which business" across Shopify's own screens (`start`). */
    cookieHash: { type: String },
    /** The `state` Shopify must send back (`start`) — or, for `pending`, the ticket the finish page presents. */
    stateHash: { type: String },
    accessTokenEnc: { type: String, select: false },
    refreshTokenEnc: { type: String, select: false },
    tokenExpiresAt: { type: Date },
    refreshTokenExpiresAt: { type: Date },
    scopes: { type: String },
    expiresAt: { type: Date, required: true }
  },
  { timestamps: true }
);

ShopifyInstallSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
ShopifyInstallSchema.index({ ticketHash: 1 }, { sparse: true });
ShopifyInstallSchema.index({ cookieHash: 1 }, { sparse: true });
ShopifyInstallSchema.index({ stateHash: 1 }, { sparse: true });

export default mongoose.model('ShopifyInstall', ShopifyInstallSchema);
