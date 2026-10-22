import mongoose from 'mongoose';
import { getNextSequence } from '../utils/sequence.js';

/**
 * One line of a delivery — a specific size of an article, with its quantity and
 * the cost per piece the supplier billed. productName/variantLabel/articleNumber
 * are SNAPSHOTS: the article may be renamed later, but what arrived under what
 * name must not change.
 */
const ReceiptLineSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.ObjectId, ref: 'Product', required: true },
    variantId: { type: mongoose.Schema.ObjectId, required: true },
    productName: { type: String, required: true },
    variantLabel: { type: String, default: 'Default' },
    articleNumber: { type: String },
    quantity: { type: Number, required: true, min: [1, 'Receive at least 1'] },
    /** How many of these have gone back to the supplier. */
    quantityReturned: { type: Number, default: 0, min: 0 },
    /** What the supplier billed per piece (paisa) — also what a return is credited at. */
    unitCostPaisa: { type: Number, required: true, min: 0 },
    /** This delivery made the article — undoing it leaves the article at zero stock. */
    createdProduct: { type: Boolean, default: false }
  },
  { _id: true }
);

/** A send-back: which lines, how many, and what it takes off what we owe. */
const ReturnSchema = new mongoose.Schema(
  {
    date: { type: Date, default: Date.now },
    note: { type: String, trim: true, maxlength: 200 },
    lines: [
      {
        lineId: { type: mongoose.Schema.ObjectId, required: true },
        quantity: { type: Number, required: true, min: 1 },
        _id: false
      }
    ],
    valuePaisa: { type: Number, required: true, min: 0 },
    entry: { type: mongoose.Schema.ObjectId, ref: 'JournalEntry', required: true },
    by: { type: mongoose.Schema.ObjectId, ref: 'User' }
  },
  { _id: true }
);

/**
 * Finished goods delivered by a supplier and bought outright: stock goes up, the
 * supplier is owed (or paid on the spot), and unsold pieces can be sent back. No
 * purchase-order step — it records what actually arrived.
 */
const GoodsReceiptSchema = new mongoose.Schema(
  {
    /** Sequential, zero-padded, unique — generated in the pre-save hook. */
    receiptNumber: { type: String, unique: true },
    business: {
      type: mongoose.Schema.ObjectId,
      ref: 'Business',
      required: [true, 'Please select a business']
    },
    party: {
      type: mongoose.Schema.ObjectId,
      ref: 'Party',
      required: [true, 'Please choose the supplier']
    },
    date: { type: Date, default: Date.now },
    note: { type: String, trim: true, maxlength: 200 },

    lines: {
      type: [ReceiptLineSchema],
      validate: {
        validator: v => Array.isArray(v) && v.length > 0,
        message: 'Add at least one line'
      }
    },
    // Denormalised for the lean list.
    lineCount: { type: Number, default: 0 },

    /** Σ quantity × unit cost (paisa). A cost field — hidden without "See costs". */
    totalCostPaisa: { type: Number, required: true, min: 0 },
    /** Paid on the spot (paisa), and where from as it read at the time. */
    paidNowPaisa: { type: Number, default: 0, min: 0 },
    paidFrom: { type: String },

    returns: { type: [ReturnSchema], default: [] },

    /** The bill (and any payment) posted when it arrived. */
    receiveEntry: { type: mongoose.Schema.ObjectId, ref: 'JournalEntry' },
    status: { type: String, enum: ['received', 'reversed'], default: 'received' },

    createdBy: { type: mongoose.Schema.ObjectId, ref: 'User', required: true },
    updatedBy: { type: mongoose.Schema.ObjectId, ref: 'User' }
  },
  // save() checks the version, so two send-backs racing on one receipt can't both land.
  { timestamps: true, optimisticConcurrency: true }
);

GoodsReceiptSchema.index({ business: 1, createdAt: -1 });
GoodsReceiptSchema.index({ business: 1, party: 1 });

GoodsReceiptSchema.pre('save', async function () {
  if (this.isNew && !this.receiptNumber) {
    const seq = await getNextSequence('goods-receipt');
    this.receiptNumber = String(seq).padStart(4, '0');
  }
  this.lineCount = this.lines.length;
});

export default mongoose.model('GoodsReceipt', GoodsReceiptSchema);
