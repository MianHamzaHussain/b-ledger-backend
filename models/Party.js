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
    /**
     * Courier only: the money account its payments usually land in ("TCS pays
     * into Meezan"). Remembered from its last invoice so the next one starts there.
     */
    defaultMoneyAccount: { type: mongoose.Schema.ObjectId, ref: 'Account' },
    /**
     * Courier only: its connection to the courier's own service (PostEx), so a parcel can be booked
     * and tracked without typing. The key is saved encrypted (utils/secretBox.js), hidden from every
     * normal read (`select: false`), and no endpoint ever returns it — only `hasToken`.
     */
    integration: {
      provider: { type: String, enum: ['postex'] },
      tokenEnc: { type: String, select: false },
      hasToken: { type: Boolean, default: false },
      isEnabled: { type: Boolean, default: false },
      /** Which of the merchant's pickup addresses to book from. */
      pickupAddressCode: { type: String, trim: true },
      pickupAddressLabel: { type: String, trim: true },
      lastCheckedAt: { type: Date },
      lastError: { type: String }
    },
    createdBy: { type: mongoose.Schema.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

PartySchema.index({ business: 1, name: 1 });
PartySchema.index({ business: 1, type: 1 });

// Belt and braces: the key is select:false already, and is stripped from any JSON as well.
PartySchema.set('toJSON', {
  transform: (doc, ret) => {
    if (ret.integration) delete ret.integration.tokenEnc;
    return ret;
  }
});

export default mongoose.model('Party', PartySchema);
