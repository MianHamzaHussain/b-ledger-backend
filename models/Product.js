import mongoose from 'mongoose';

/**
 * One sellable SKU. Cost, sale price, stock and barcode live HERE, never on the
 * product — every sale, stock move and report reads variants, whether a product
 * has one or twenty.
 *
 * `label` is a free-text name for the variant ("Unstitched", "M", "Large"), or
 * "Default" for a product sold in a single form. This deliberately replaces
 * structured options: for this business, a variant is just a named line with a
 * quantity, so one article ("Article A") can hold an Unstitched line and each
 * stitched size as sibling variants in a single product.
 *
 * `barcode` is auto-generated and globally unique, so a scan resolves to exactly
 * one SKU. `_id` is kept so the client can key and edit rows.
 */
const VariantSchema = new mongoose.Schema(
  {
    label: {
      type: String,
      trim: true,
      maxlength: [40, 'Variant name can not be more than 40 characters'],
      default: 'Default'
    },
    /**
     * Cost is owned by Production — it is set (and moving-averaged) when a batch
     * closes, not on the product form. New variants start at 0 until their first
     * batch. So it defaults to 0 rather than being required from the client.
     */
    costPrice: {
      type: Number,
      default: 0,
      min: [0, 'Cost price can not be negative']
    },
    salePrice: {
      type: Number,
      required: [true, 'Please add a sale price'],
      min: [0, 'Sale price can not be negative']
    },
    stock: {
      type: Number,
      default: 0,
      min: [0, 'Stock can not be negative']
    },
    barcode: { type: String }
  },
  { _id: true }
);

const ProductSchema = new mongoose.Schema(
  {
    /** Scoping anchor — a product belongs to exactly one business. */
    business: {
      type: mongoose.Schema.ObjectId,
      ref: 'Business',
      required: [true, 'Please select a business']
    },
    /** Derived from the business (a business has one category); client can't set it. */
    category: {
      type: mongoose.Schema.ObjectId,
      ref: 'Category',
      required: [true, 'Please select a category']
    },
    name: {
      type: String,
      required: [true, 'Please add a product name'],
      trim: true,
      maxlength: [120, 'Name can not be more than 120 characters']
    },
    /** Short human-facing code for search. Auto-generated, unique. */
    articleNumber: {
      type: String,
      unique: true,
      uppercase: true,
      trim: true
    },
    /** A variant is "low" when its stock is at or below this. 0 disables it. */
    lowStockThreshold: {
      type: Number,
      default: 0,
      min: [0, 'Threshold can not be negative']
    },
    variants: {
      type: [VariantSchema],
      default: []
    },
    /**
     * Denormalised so the lean list shows stock/variant counts without shipping
     * the variants array. `variantCount` follows the array (set in the save hook);
     * `totalStock` is kept in step both here and by the atomic $inc in
     * `utils/stock.js` (order reserve/release bypasses the hook).
     */
    totalStock: { type: Number, default: 0 },
    variantCount: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active'
    },
    createdBy: { type: mongoose.Schema.ObjectId, ref: 'User', required: true },
    updatedBy: { type: mongoose.Schema.ObjectId, ref: 'User' }
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// Every barcode is unique across the whole catalogue, so a scan maps to one SKU.
ProductSchema.index({ 'variants.barcode': 1 }, { unique: true, sparse: true });
ProductSchema.index({ business: 1, name: 1 });
ProductSchema.index({ business: 1, status: 1 });

/** No-confusion alphabet (no O/0, I/1). 4 chars ≈ 1.5M codes. */
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

ProductSchema.statics.generateArticleNumber = async function () {
  for (let tries = 0; tries < 25; tries++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!(await this.exists({ articleNumber: code }))) return code;
  }
  throw new Error('Could not generate a unique article number');
};

ProductSchema.statics.generateBarcode = async function () {
  for (let tries = 0; tries < 25; tries++) {
    // 12 digits, leading 2 — the GS1 "restricted / in-store" range, correct for
    // internal codes and safe to print as Code128/EAN without a paid prefix.
    let code = '2';
    for (let i = 0; i < 11; i++) code += Math.floor(Math.random() * 10);
    if (!(await this.exists({ 'variants.barcode': code }))) return code;
  }
  throw new Error('Could not generate a unique barcode');
};

/**
 * Derive the category from the business, require ≥1 variant, and keep variant
 * names distinct within the product (so you don't add "M" twice).
 */
ProductSchema.pre('validate', async function () {
  // Category is the business's — derived, never taken from the client (the
  // controller strips it). A business has one category, fixed once its business
  // is chosen; asking would only let the two diverge.
  if (this.business && !this.category) {
    const biz = await mongoose.model('Business').findById(this.business).select('category');
    if (!biz) {
      this.invalidate('business', 'Business not found');
      return;
    }
    this.category = biz.category;
  }

  const variants = this.variants || [];
  if (variants.length === 0) {
    this.invalidate('variants', 'A product needs at least one variant');
    return;
  }

  const seen = new Set();
  for (const variant of variants) {
    const key = (variant.label || 'Default').trim().toLowerCase();
    if (seen.has(key)) {
      this.invalidate('variants', `Duplicate variant "${variant.label}"`);
    }
    seen.add(key);
  }
});

/** Generate the article number (once) and any missing variant barcodes, and
 *  keep the denormalised counts in step with the variants. */
ProductSchema.pre('save', async function () {
  if (this.isNew && !this.articleNumber) {
    this.articleNumber = await this.constructor.generateArticleNumber();
  }
  for (const variant of this.variants) {
    if (!variant.barcode) variant.barcode = await this.constructor.generateBarcode();
  }
  this.variantCount = this.variants.length;
  this.totalStock = this.variants.reduce((sum, v) => sum + (v.stock || 0), 0);
});

export default mongoose.model('Product', ProductSchema);
