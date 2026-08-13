import mongoose from 'mongoose';
import { getNextSequence } from '../utils/sequence.js';

/**
 * One line of a consignment — a specific SKU handed to the reseller, tracked
 * independently so he can return some and keep (pay for) others.
 *
 * productName/variantLabel/unitCost are SNAPSHOTS at issue time: the goods stay
 * YOUR inventory (parked in Goods-on-Approval at this cost) until the line is
 * returned or sold, so its cost and the agreed price must not shift under it if
 * the product is later repriced.
 */
const ConsignmentLineSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.ObjectId,
      ref: 'Product',
      required: [true, 'Please choose a product']
    },
    variantId: { type: mongoose.Schema.ObjectId, required: [true, 'Please choose a variant'] },
    productName: { type: String, required: true },
    variantLabel: { type: String, default: 'Default' },

    quantityIssued: { type: Number, required: true, min: [1, 'Issue at least 1'] },
    quantityReturned: { type: Number, default: 0, min: 0 },
    quantitySold: { type: Number, default: 0, min: 0 },

    /** Snapshot at issue: your cost, and the agreed price the reseller owes per unit. */
    unitCostPaisa: { type: Number, required: true, min: 0 },
    unitPricePaisa: { type: Number, required: true, min: 0 }
  },
  { _id: true }
);

/** Still out with the reseller on this line. */
ConsignmentLineSchema.virtual('remaining').get(function () {
  return this.quantityIssued - this.quantityReturned - this.quantitySold;
});
ConsignmentLineSchema.set('toJSON', { virtuals: true });
ConsignmentLineSchema.set('toObject', { virtuals: true });

/**
 * Goods handed to a reseller on **sale or return** — the "10 suits against his
 * name" arrangement, now a document with many lines (like an order/delivery
 * note). No revenue is recognised at hand-over (FINANCE spec §04): the stock is
 * parked in Goods-on-Approval at cost and only becomes a sale when a line is
 * kept/paid, which is why returns are frictionless.
 */
const ConsignmentSchema = new mongoose.Schema(
  {
    /** Sequential, zero-padded, unique — generated in the pre-save hook. */
    consignmentNumber: { type: String, unique: true },
    business: {
      type: mongoose.Schema.ObjectId,
      ref: 'Business',
      required: [true, 'Please select a business']
    },
    party: {
      type: mongoose.Schema.ObjectId,
      ref: 'Party',
      required: [true, 'Please choose the reseller']
    },

    lines: {
      type: [ConsignmentLineSchema],
      validate: {
        validator: v => Array.isArray(v) && v.length > 0,
        message: 'A consignment needs at least one line'
      }
    },

    // ── Denormalised for the lean list (§6.5) ──────────────────────────────
    /** Number of lines — so the list shows it without shipping the lines array. */
    lineCount: { type: Number, default: 0 },
    /** Units still out across all lines. Zero ⇒ fully settled. */
    unitsRemaining: { type: Number, default: 0 },

    /** `out` while anything is still with the reseller; `settled` once nothing is. */
    status: { type: String, enum: ['out', 'settled'], default: 'out' },

    // ── Money axis (independent of the goods axis, like an order) ───────────
    /** Value of units the reseller has KEPT so far, at the agreed price (paisa).
     *  This is what he owes for; returns never count. */
    billedPaisa: { type: Number, default: 0 },
    /** Of that, how much he has actually paid (paisa). */
    paidPaisa: { type: Number, default: 0 },
    /** Derived from billed vs paid: `unbilled` (nothing kept yet) → `unpaid` →
     *  `partial` → `paid`. Denormalised so the lean list can show it. */
    paymentStatus: {
      type: String,
      enum: ['unbilled', 'unpaid', 'partial', 'paid'],
      default: 'unbilled'
    },

    /** The Goods-on-Approval entry posted once at issue. */
    issueEntry: { type: mongoose.Schema.ObjectId, ref: 'JournalEntry' },

    createdBy: { type: mongoose.Schema.ObjectId, ref: 'User', required: true },
    updatedBy: { type: mongoose.Schema.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

ConsignmentSchema.index({ business: 1, party: 1, status: 1 });
ConsignmentSchema.index({ business: 1, createdAt: -1 });

/** True while no line has been returned or sold — the only state that's editable.
 *  Guarded: the lean list projection omits `lines`, and this virtual still runs
 *  when that list is serialised to JSON. */
ConsignmentSchema.virtual('isUntouched').get(function () {
  return (this.lines || []).every(
    l => (l.quantityReturned || 0) === 0 && (l.quantitySold || 0) === 0
  );
});

/** Generate the number once, and keep the denormalised fields + status derived. */
ConsignmentSchema.pre('save', async function () {
  if (this.isNew && !this.consignmentNumber) {
    const seq = await getNextSequence('consignment');
    this.consignmentNumber = String(seq).padStart(4, '0');
  }

  this.lineCount = this.lines.length;
  this.unitsRemaining = this.lines.reduce(
    (sum, l) => sum + (l.quantityIssued - l.quantityReturned - l.quantitySold),
    0
  );
  this.status = this.unitsRemaining === 0 ? 'settled' : 'out';

  // Money axis — derived from what's been kept (billed) vs paid.
  if (this.billedPaisa <= 0) this.paymentStatus = 'unbilled';
  else if (this.paidPaisa >= this.billedPaisa) this.paymentStatus = 'paid';
  else if (this.paidPaisa > 0) this.paymentStatus = 'partial';
  else this.paymentStatus = 'unpaid';
});

ConsignmentSchema.set('toJSON', { virtuals: true });
ConsignmentSchema.set('toObject', { virtuals: true });

export default mongoose.model('Consignment', ConsignmentSchema);
