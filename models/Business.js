import mongoose from 'mongoose';

/** Shared URL validator. Empty is allowed; a present value must be a real URL. */
const optionalUrl = (label, hostPattern) => ({
  validator(value) {
    if (!value) return true;
    let url;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    return hostPattern ? hostPattern.test(url.hostname) : true;
  },
  message: `Please provide a valid ${label}`
});

/**
 * A business is one brand/storefront — its own store link plus the social and
 * WhatsApp channels orders arrive through.
 *
 * It is also the scoping anchor for the whole permission system: users are
 * assigned to businesses, and `scope: 'own'` resolves to "rows belonging to
 * the businesses I am assigned to". Order, payment and expense models will all
 * carry a `business` ref for exactly this reason.
 */
const BusinessSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please add a business name'],
      unique: true,
      trim: true,
      maxlength: [100, 'Name can not be more than 100 characters']
    },
    /**
     * Named `category`, not `categoryId` — ref fields are named for the model
     * they point at (see CLAUDE.md §4), matching `role` on User. Populated, it
     * is the category object.
     */
    category: {
      type: mongoose.Schema.ObjectId,
      ref: 'Category',
      required: [true, 'Please select a category']
    },
    storeLink: {
      type: String,
      trim: true,
      validate: optionalUrl('store link')
    },
    facebookLink: {
      type: String,
      trim: true,
      validate: optionalUrl('Facebook link', /(^|\.)(facebook\.com|fb\.com|fb\.me)$/i)
    },
    instagramLink: {
      type: String,
      trim: true,
      validate: optionalUrl('Instagram link', /(^|\.)instagram\.com$/i)
    },
    whatsappNumber: {
      type: String,
      trim: true,
      // E.164-ish. Deliberately permissive on formatting, strict on shape.
      match: [/^\+?[0-9\s-]{7,20}$/, 'Please provide a valid WhatsApp number']
    },
    /**
     * FBR taxes the courier withholds from COD before remitting. Whether the WHT
     * is a reclaimable asset or a plain cost depends on `registered`, so this
     * lives per business — the ledger then calculates each business correctly.
     */
    codTax: {
      registered: { type: Boolean, default: false },
      whtPercent: {
        type: Number,
        default: 2,
        min: [0, 'Withholding rate can not be negative'],
        max: [100, 'Withholding rate can not exceed 100']
      },
      salesTaxPercent: {
        type: Number,
        default: 2,
        min: [0, 'Sales tax rate can not be negative'],
        max: [100, 'Sales tax rate can not exceed 100']
      }
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active'
    },
    createdBy: { type: mongoose.Schema.ObjectId, ref: 'User', required: true },
    updatedBy: { type: mongoose.Schema.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

/** Matches the common list query: active businesses, sorted by name. */
BusinessSchema.index({ status: 1, name: 1 });
BusinessSchema.index({ category: 1 });

export default mongoose.model('Business', BusinessSchema);
