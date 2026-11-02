import mongoose from 'mongoose';

/**
 * "This Shopify product size is that stock item." Made once — by the app when the names match exactly, or by a
 * person on the Needs attention list — and used for every later order, so the same product never asks twice.
 */
const ShopifyVariantLinkSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.ObjectId, ref: 'Business', required: true },
    shopifyVariantId: { type: String, required: true },
    shopifyProductId: { type: String },
    /** What Shopify calls it, kept so a person can recognise the link later. */
    shopifyTitle: { type: String },
    product: { type: mongoose.Schema.ObjectId, ref: 'Product', required: true },
    variantId: { type: mongoose.Schema.ObjectId, required: true },
    /** `auto` = the names matched exactly; `person` = someone chose it. */
    madeBy: { type: String, enum: ['auto', 'person'], default: 'person' }
  },
  { timestamps: true }
);

ShopifyVariantLinkSchema.index({ business: 1, shopifyVariantId: 1 }, { unique: true });

export default mongoose.model('ShopifyVariantLink', ShopifyVariantLinkSchema);
