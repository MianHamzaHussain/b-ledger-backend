import mongoose from 'mongoose';
import { ACCOUNT_TYPES, MONEY_KINDS, NORMAL_BALANCE } from '../utils/constants.js';

/**
 * One line of the chart of accounts, scoped to a business. Seeded with a
 * standard chart the first time a business touches the books (see
 * utils/chartOfAccounts.js), so every business starts able to record.
 *
 * `isControl` marks accounts whose detail lives in a party ledger — Accounts
 * Receivable, Accounts Payable, COD-with-courier, Goods-on-approval. Their
 * balance is meaningful in total, but the "who" comes from the `party` on each
 * journal line, not from a separate account per person.
 */
const AccountSchema = new mongoose.Schema(
  {
    business: {
      type: mongoose.Schema.ObjectId,
      ref: 'Business',
      required: [true, 'Please select a business']
    },
    /** Stable numeric code ('1000'). Referenced by the posting engine. */
    code: {
      type: String,
      required: [true, 'Please add an account code'],
      uppercase: true,
      trim: true
    },
    name: {
      type: String,
      required: [true, 'Please add an account name'],
      trim: true,
      maxlength: [60, 'Name can not be more than 60 characters']
    },
    type: {
      type: String,
      enum: Object.values(ACCOUNT_TYPES),
      required: [true, 'Please choose an account type']
    },
    /** Derived from type in pre-validate — never taken from the client. */
    normalBalance: {
      type: String,
      enum: ['debit', 'credit']
    },
    isControl: { type: Boolean, default: false },
    isSystem: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    /**
     * Set only on a money account — a real place money sits: the shop's cash,
     * one bank account, one JazzCash/Easypaisa number. Everything that moves
     * money names one of these (or a partner), never a bare "cash"/"bank".
     */
    moneyKind: { type: String, enum: Object.values(MONEY_KINDS) },
    /** Bank account / wallet number as the owner reads it, e.g. "…4521". */
    number: { type: String, trim: true, maxlength: [40, 'Number is too long'] },
    createdBy: { type: mongoose.Schema.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

/** One code per business. */
AccountSchema.index({ business: 1, code: 1 }, { unique: true });

/** The normal side is a fact of the account's type, not an input. */
AccountSchema.pre('validate', function () {
  if (this.type) this.normalBalance = NORMAL_BALANCE[this.type];
});

export default mongoose.model('Account', AccountSchema);
