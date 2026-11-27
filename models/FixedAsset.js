import mongoose from 'mongoose';
import { ASSET_STATUS } from '../utils/constants.js';

/**
 * One thing the business bought to keep and use — a light stand, a sewing machine. Buying it posts to Fixed Assets
 * (`purchaseEntry`); this row is what lets the app know **which** item it was and what it cost, so selling or
 * throwing it away can book the right gain or loss itself. Money is integer paisa, like everywhere.
 */
const FixedAssetSchema = new mongoose.Schema(
  {
    business: {
      type: mongoose.Schema.ObjectId,
      ref: 'Business',
      required: [true, 'Please select a business']
    },
    name: {
      type: String,
      required: [true, 'Please name the asset'],
      trim: true,
      maxlength: [80, 'Name can not be more than 80 characters']
    },
    costPaisa: {
      type: Number,
      required: [true, 'Please add what it cost'],
      min: [1, 'The cost must be more than zero']
    },
    boughtOn: { type: Date, required: [true, 'Please add the day it was bought'] },
    /** The entry that bought it — sparse-unique, so one purchase is one asset. */
    purchaseEntry: { type: mongoose.Schema.ObjectId, ref: 'JournalEntry' },
    /**
     * How much of the depreciation ever posted belongs to THIS item (Accumulated Depreciation is one pooled
     * account). Set by an accountant when it is sold; 0 otherwise. It only changes what the sale books as a gain or loss.
     */
    depreciationPaisa: { type: Number, default: 0, min: [0, 'Depreciation can not be negative'] },
    status: {
      type: String,
      enum: Object.values(ASSET_STATUS),
      default: ASSET_STATUS.IN_USE
    },
    /** Filled when it is sold or thrown away. */
    sale: {
      date: { type: Date },
      pricePaisa: { type: Number },
      account: { type: mongoose.Schema.ObjectId, ref: 'Account' },
      entry: { type: mongoose.Schema.ObjectId, ref: 'JournalEntry' },
      /** Positive: extra profit; negative: a loss to the business. */
      gainLossPaisa: { type: Number },
      buyerName: {
        type: String,
        trim: true,
        maxlength: [80, 'Name can not be more than 80 characters']
      }
    },
    note: {
      type: String,
      trim: true,
      maxlength: [200, 'Note can not be more than 200 characters']
    },
    createdBy: { type: mongoose.Schema.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

FixedAssetSchema.index({ business: 1, status: 1 });
FixedAssetSchema.index({ purchaseEntry: 1 }, { unique: true, sparse: true });

export default mongoose.model('FixedAsset', FixedAssetSchema);
