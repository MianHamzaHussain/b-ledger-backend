import mongoose from 'mongoose';

/**
 * A PostEx Cash Payment Receipt (CPR) added to a courier's wallet. PostEx releases one per payout; it is the only
 * record of what PostEx actually paid and charged, parcel by parcel, so it — not a calculation — fills the wallet.
 * One document per (business, courier, CPR number): adding the same receipt again only finishes the rows still waiting.
 * Only the figures are kept, never the PDF and never a customer's details.
 */
const RowSchema = new mongoose.Schema(
  {
    tracking: { type: String, required: true },
    status: { type: String, enum: ['delivered', 'returned'], required: true },
    codPaisa: { type: Number, required: true },
    shippingPaisa: { type: Number, required: true },
    gstPaisa: { type: Number, required: true },
    deductionPaisa: { type: Number, required: true },
    /** What PostEx paid (+) or took (−) for this parcel. */
    netPaisa: { type: Number, required: true },
    order: { type: mongoose.Schema.ObjectId, ref: 'Order' },
    /** applied: on the wallet · pending: waiting for a person · ignored: not a parcel of this business in B Ledger */
    outcome: { type: String, enum: ['applied', 'pending', 'ignored'], required: true },
    /** How the parcel was settled: paid, topup, charge, moveCharge, chargeDiff (see utils/courierReceipts.js). */
    case: { type: String },
    reason: { type: String },
    /** The journal entry that put this parcel on the wallet. */
    entry: { type: mongoose.Schema.ObjectId, ref: 'JournalEntry' },
    /** What the parcel held before this receipt touched it, so undoing the entry can put it back exactly. */
    previous: { type: mongoose.Schema.Types.Mixed }
  },
  { _id: false }
);

const CourierReceiptSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.ObjectId, ref: 'Business', required: true },
    courier: { type: mongoose.Schema.ObjectId, ref: 'Party', required: true },
    cprNumber: { type: String, required: true },
    cprDate: { type: Date, required: true },
    merchant: { type: String },
    totals: {
      netPaisa: Number,
      codPaisa: Number,
      shippingPaisa: Number,
      gstPaisa: Number,
      deductionPaisa: Number,
      delivered: Number,
      returned: Number
    },
    rows: { type: [RowSchema], default: [] },
    /** The journal entries made from this receipt (one per time it was added). */
    entries: { type: [mongoose.Schema.ObjectId], ref: 'JournalEntry', default: [] },
    /** Held while a receipt is being added, so two taps cannot add it twice. */
    applyingAt: { type: Date },
    importedBy: { type: mongoose.Schema.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

CourierReceiptSchema.index({ business: 1, courier: 1, cprNumber: 1 }, { unique: true });
CourierReceiptSchema.index({ business: 1, courier: 1, cprDate: -1 });
CourierReceiptSchema.index({ entries: 1 }, { sparse: true });
// A refund or exchange looks up PostEx's own figures for a parcel, by order and by (reversal) tracking number.
CourierReceiptSchema.index({ business: 1, 'rows.order': 1 });
CourierReceiptSchema.index({ business: 1, 'rows.tracking': 1 });

export default mongoose.model('CourierReceipt', CourierReceiptSchema);
