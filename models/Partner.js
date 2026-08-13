import mongoose from 'mongoose';

/**
 * An owner / partner in the business — an EQUITY stake, not a trade party.
 * Their money is capital: contributions raise it, withdrawals (drawings) lower
 * it, and their `sharePercent` of profit is allocated to it at distribution.
 *
 * Each partner owns a dedicated equity account (`capitalAccount`) in the chart,
 * so their capital sits in the Equity section of the balance sheet on its own
 * and never mixes into receivables/payables. Balance is derived from that
 * account's journal lines, never stored.
 */
const PartnerSchema = new mongoose.Schema(
  {
    business: {
      type: mongoose.Schema.ObjectId,
      ref: 'Business',
      required: [true, 'Please select a business']
    },
    name: {
      type: String,
      required: [true, 'Please add a name'],
      trim: true,
      maxlength: [100, 'Name can not be more than 100 characters']
    },
    /** Share of profit, 0–100. Active partners' shares should total 100. */
    sharePercent: {
      type: Number,
      default: 0,
      min: [0, 'Share can not be negative'],
      max: [100, 'Share can not be more than 100']
    },
    phone: { type: String, trim: true },
    note: {
      type: String,
      trim: true,
      maxlength: [200, 'Note can not be more than 200 characters']
    },
    isActive: { type: Boolean, default: true },
    /** The partner's own equity account — set by the controller on create. */
    capitalAccount: { type: mongoose.Schema.ObjectId, ref: 'Account', required: true },
    createdBy: { type: mongoose.Schema.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

PartnerSchema.index({ business: 1, name: 1 });

export default mongoose.model('Partner', PartnerSchema);
