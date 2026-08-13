import mongoose from 'mongoose';

/**
 * Product category for a business — "Clothing", "Cosmetics", and whatever gets
 * added next without a code change.
 *
 * Deliberately minimal. It exists as a collection rather than an enum so an
 * admin can add one, and because it is the natural place for the per-category
 * fields a P&L system eventually needs (default margin, commission rate).
 * Do not add those until something actually uses them.
 */
const CategorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please add a category name'],
      // NOT `unique: true` — that creates a plain {name:1} index, and MongoDB
      // refuses a second index with the same key pattern, so the collation
      // index below would be silently skipped. Uniqueness is enforced there.
      trim: true,
      maxlength: [50, 'Name can not be more than 50 characters']
    },
    description: {
      type: String,
      trim: true,
      maxlength: [200, 'Description can not be more than 200 characters']
    },
    /**
     * The master menu of variant labels every product in this category may stock
     * ("Unstitched", "S", "M", "L", "XL"). Defined once here so the same set is
     * not retyped on every product — a product simply ticks which of these apply.
     *
     * Order is the display order in the product form. A category with no options
     * (e.g. a single-SKU cosmetic) leaves this empty and its products get one
     * unnamed "Default" variant. Normalised in the pre-validate hook below.
     */
    variantOptions: {
      type: [String],
      default: []
    },
    /** Count of variantOptions — denormalised so the lean list can show it
     *  without shipping the whole array. Kept in step in the pre-validate hook. */
    variantCount: {
      type: Number,
      default: 0
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active'
    },
    createdBy: { type: mongoose.Schema.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

/** Case-insensitive uniqueness — "Clothing" and "clothing" are one category. */
CategorySchema.index({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

/**
 * Normalise the variant-option menu: trim, drop blanks, and dedupe
 * case-insensitively while keeping the author's order and casing (first wins).
 * Done here rather than trusting the client so "S", " s " and "S" collapse to
 * one — the same key a product variant is deduped by.
 */
CategorySchema.pre('validate', function () {
  if (!Array.isArray(this.variantOptions)) return;

  const seen = new Set();
  const cleaned = [];
  for (const raw of this.variantOptions) {
    const label = String(raw || '').trim();
    if (!label) continue;
    if (label.length > 40) {
      this.invalidate('variantOptions', 'A variant option can not be more than 40 characters');
      return;
    }
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(label);
  }
  if (cleaned.length > 30) {
    this.invalidate('variantOptions', 'A category can not have more than 30 variant options');
    return;
  }
  this.variantOptions = cleaned;
  this.variantCount = cleaned.length;
});

export default mongoose.model('Category', CategorySchema);
