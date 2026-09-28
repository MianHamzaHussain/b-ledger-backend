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
    /** Optional — some invoices carry none (a TCS week can have a blank number). */
    invoiceNumber: { type: String, trim: true, maxlength: 60 },
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

// A typed invoice number is unique per courier, so the same invoice can't be entered
// twice. Partial: invoices without a number aren't held to it (a missing value
// would otherwise count as a duplicate null); the per-parcel checks still stop a
// COD or charge being settled twice. A reversed invoice's record is removed,
// freeing its number.
CourierInvoiceSchema.index(
  { business: 1, courier: 1, invoiceNumber: 1 },
  {
    unique: true,
    name: 'invoice_number_per_courier',
    partialFilterExpression: { invoiceNumber: { $type: 'string' } }
  }
);

export default mongoose.model('CourierInvoice', CourierInvoiceSchema);
