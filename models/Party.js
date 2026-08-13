import mongoose from 'mongoose';
import { PARTY_TYPES } from '../utils/constants.js';

/**
 * A person or company the business has a running account with — a supplier or
 * tailor we owe, a reseller who owes us, an employee, a courier, or a walk-in
 * customer we've extended credit to. This is the "against his name" record.
 *
 * A party has no stored balance: it is derived from the journal lines tagged to
 * it (see utils/ledger.js `partyBalance`), so it can never fall out of step with
 * the books. Opening balances at cutover are posted as an opening journal entry,
 * not written here.
 */
const PartySchema = new mongoose.Schema(
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
    type: {
      type: String,
      enum: Object.values(PARTY_TYPES),
      required: [true, 'Please choose a party type']
    },
    phone: { type: String, trim: true },
    /** Merchant/account id with the party — mainly a courier account number. */
    accountId: {
      type: String,
      trim: true,
      maxlength: [60, 'Account ID can not be more than 60 characters']
    },
    note: {
      type: String,
      trim: true,
      maxlength: [200, 'Note can not be more than 200 characters']
    },
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

PartySchema.index({ business: 1, name: 1 });
PartySchema.index({ business: 1, type: 1 });

export default mongoose.model('Party', PartySchema);
