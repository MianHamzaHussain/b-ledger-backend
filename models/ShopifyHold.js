import mongoose from 'mongoose';

/**
 * A Shopify order that could not be turned into an order by itself — a product with no match in stock, a payment
 * taken online, a total that does not add up. It waits here with the reason, and is brought in once a person has
 * fixed the cause (mapping the product) or ignores it. `raw` keeps Shopify's own copy so nothing has to be asked again.
 */
const ShopifyHoldSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.ObjectId, ref: 'Business', required: true },
    shopifyOrderId: { type: String, required: true },
    /** The store's number for it, e.g. "51487". */
    name: { type: String },
    shopifyCreatedAt: { type: Date },
    customerName: { type: String },
    reasons: { type: [String], default: [] },
    /** Items with no matching product yet — what the person is asked to match. */
    unmatched: {
      type: [
        {
          title: String,
          variantTitle: String,
          variantId: String,
          productId: String,
          _id: false
        }
      ],
      default: []
    },
    status: { type: String, enum: ['open', 'done', 'ignored'], default: 'open' },
    raw: { type: mongoose.Schema.Types.Mixed },
    resolvedAt: { type: Date }
  },
  { timestamps: true }
);

ShopifyHoldSchema.index({ business: 1, shopifyOrderId: 1 }, { unique: true });
ShopifyHoldSchema.index({ business: 1, status: 1 });

export default mongoose.model('ShopifyHold', ShopifyHoldSchema);
