import mongoose from 'mongoose';
import { MATERIAL_UNITS } from '../utils/constants.js';

/**
 * A raw material the business keeps in bulk — base dye, thread cones, ready
 * embroidered pieces — bought before any article is made from it.
 *
 * It is STOCK, not an expense: buying it swaps cash for material (Dr Raw
 * materials), a production batch later moves it into the article's cost, and it
 * reaches profit only when that article sells. So a purchase never hits profit
 * and nothing is counted twice.
 *
 * Valued at moving average. The total value is stored rather than a unit cost,
 * so taking part of it never drifts by rounding: the last unit out takes exactly
 * what is left, and Σ material values always equals the Raw materials account.
 * Stock and value change only through utils/materials.js.
 */
const MaterialSchema = new mongoose.Schema(
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
      maxlength: [60, 'Name can not be more than 60 characters']
    },
    unit: {
      type: String,
      enum: { values: MATERIAL_UNITS, message: 'Choose how it is counted' },
      default: 'piece'
    },
    /** On hand, in `unit`. Fractional for metres/kg; rounded to 3 places. */
    stock: { type: Number, default: 0, min: [0, 'Stock can not be negative'] },
    /** What the stock on hand cost in total (paisa). */
    valuePaisa: { type: Number, default: 0 },
    /** Warn when stock falls to this or below. Unset = no warning. */
    lowStockAt: { type: Number, min: [0, 'Can not be negative'] },
    note: {
      type: String,
      trim: true,
      maxlength: [200, 'Note can not be more than 200 characters']
    },
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.ObjectId, ref: 'User', required: true },
    updatedBy: { type: mongoose.Schema.ObjectId, ref: 'User' }
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

MaterialSchema.index(
  { business: 1, name: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 } }
);

/** Average cost of one unit (paisa, rounded — the exact value is `valuePaisa`). */
MaterialSchema.virtual('unitCostPaisa').get(function () {
  return this.stock > 0 ? Math.round(this.valuePaisa / this.stock) : 0;
});

export default mongoose.model('Material', MaterialSchema);
