import mongoose from 'mongoose';

/**
 * A courier's invoice as recorded in B Ledger — the paper trail behind one
 * ledger entry. The courier bills per parcel (tracking id) and pays per week,
 * and it may pay a parcel's COD on one invoice and bill its charge on another,
 * so each invoice just lists what it settled. Keeping the number lets the same
 * invoice not be entered twice.
 */
const CourierInvoiceSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.ObjectId, ref: 'Business', required: true },
    courier: { type: mongoose.Schema.ObjectId, ref: 'Party', required: true },
    invoiceNumber: { type: String, required: true, trim: true, maxlength: 60 },
    invoiceDate: { type: Date },
    /**
     * The one ledger entry the invoice posted — absent only for an invoice that
     * moved no money and billed only zero charges.
     */
    entry: { type: mongoose.Schema.ObjectId, ref: 'JournalEntry' },
    /** What actually arrived, and what the ticked items said should (paisa). */
    receivedPaisa: { type: Number, default: 0 },
    expectedPaisa: { type: Number, default: 0 },
    codOrders: [{ type: mongoose.Schema.ObjectId, ref: 'Order' }],
    charges: [
      {
        _id: false,
        order: { type: mongoose.Schema.ObjectId, ref: 'Order' },
        kind: { type: String, enum: ['delivery', 'return'] },
        amountPaisa: Number
      }
    ],
    createdBy: { type: mongoose.Schema.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

// One record per courier invoice number — entering the same invoice twice would
// pay its orders twice. (A reversed invoice's record is removed, freeing it.)
CourierInvoiceSchema.index({ business: 1, courier: 1, invoiceNumber: 1 }, { unique: true });

export default mongoose.model('CourierInvoice', CourierInvoiceSchema);
