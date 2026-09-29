import mongoose from 'mongoose';

/**
 * One line of a material's history — what came in and what went out, and why.
 * `quantity` and `valuePaisa` are signed: + into stock, − out of it. The ledger
 * entry (`entry`) is the money side; this is the stock-keeping side.
 *
 *   purchase — bought (paid, or on credit to `party`)
 *   use      — taken by production `batch` for `product`, or by an `order`'s
 *              custom work
 *   wasted   — used up / spoiled / lost outside a batch
 *   count    — the shelf was counted and differed (either sign)
 */
export const MATERIAL_MOVES = ['purchase', 'use', 'wasted', 'count'];

const MaterialMoveSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.ObjectId, ref: 'Business', required: true },
    material: { type: mongoose.Schema.ObjectId, ref: 'Material', required: true },
    kind: { type: String, enum: MATERIAL_MOVES, required: true },
    quantity: { type: Number, required: true },
    valuePaisa: { type: Number, default: 0 },
    batch: { type: mongoose.Schema.ObjectId, ref: 'ProductionBatch' },
    product: { type: mongoose.Schema.ObjectId, ref: 'Product' },
    order: { type: mongoose.Schema.ObjectId, ref: 'Order' },
    party: { type: mongoose.Schema.ObjectId, ref: 'Party' },
    /** Where a purchase was paid from, by name — kept for the history line. */
    paidFrom: { type: String, trim: true },
    entry: { type: mongoose.Schema.ObjectId, ref: 'JournalEntry' },
    note: {
      type: String,
      trim: true,
      maxlength: [200, 'Note can not be more than 200 characters']
    },
    date: { type: Date, default: Date.now },
    createdBy: { type: mongoose.Schema.ObjectId, ref: 'User', required: true }
  },
  { timestamps: true }
);

MaterialMoveSchema.index({ material: 1, createdAt: -1 });
MaterialMoveSchema.index({ batch: 1 });

export default mongoose.model('MaterialMove', MaterialMoveSchema);
