import mongoose from 'mongoose';

/**
 * A production/receipt batch: one product, several of its variants stocked at
 * once. Each line carries its OWN quantity and unit cost, so variants are
 * costed independently. A batch is built as a **draft** (`open`), then **closed**
 * — which posts to inventory and, per variant, adds the quantity to stock and
 * re-averages the variant's cost (see productionController). Amounts on the wire
 * are rupees; unit cost is stored as integer paisa to match the ledger.
 */
/**
 * One itemised cost that went into a variant's batch — "Cloth", "Tailor",
 * "Packing". Kept as a breakdown (not a single number) so you can see WHAT a
 * variant's cost is made of. The lines sum to the variant's total cost.
 */
const CostLineSchema = new mongoose.Schema(
  {
    label: {
      type: String,
      required: [true, 'Add a cost label'],
      trim: true,
      maxlength: [60, 'Label can not be more than 60 characters']
    },
    amountPaisa: { type: Number, required: true, min: [1, 'Amount must be greater than zero'] },
    /**
     * How THIS cost is funded — so cloth can be owed to one supplier while packing
     * is paid cash. `onCredit` grows the `party`'s payable (shows on their
     * statement); otherwise it is paid from cash/bank at close.
     */
    method: { type: String, enum: ['cash', 'bank'], default: 'cash' },
    onCredit: { type: Boolean, default: false },
    party: { type: mongoose.Schema.ObjectId, ref: 'Party' }
  },
  { _id: true }
);

const BatchLineSchema = new mongoose.Schema(
  {
    /** Which variant (an embedded Product.variants id) this line stocks. */
    variantId: { type: mongoose.Schema.ObjectId, required: [true, 'Please select a variant'] },
    variantLabel: { type: String, default: 'Default' },
    quantity: {
      type: Number,
      required: [true, 'Please add a quantity'],
      min: [1, 'Quantity must be at least 1']
    },
    /**
     * The itemised costs for this variant's run. They sum to the variant's total
     * cost; ÷ quantity gives the unit cost that is moving-averaged into the
     * product's variant on close.
     */
    costLines: {
      type: [CostLineSchema],
      validate: {
        validator: v => Array.isArray(v) && v.length > 0,
        message: 'Add at least one cost for each variant'
      }
    },
    /**
     * The sale price to set on the variant when the batch closes (rupees). Seeded
     * from the variant's current price in the form; the user can adjust it in the
     * close review before it commits.
     */
    salePrice: { type: Number, min: [0, 'Price can not be negative'] }
  },
  { _id: true }
);

/** Total cost of a variant line (paisa) = Σ its cost lines. */
BatchLineSchema.virtual('totalCostPaisa').get(function () {
  return (this.costLines || []).reduce((sum, c) => sum + (c.amountPaisa || 0), 0);
});
/** Unit cost (paisa) = total ÷ quantity, rounded. */
BatchLineSchema.virtual('unitCostPaisa').get(function () {
  const total = (this.costLines || []).reduce((sum, c) => sum + (c.amountPaisa || 0), 0);
  return this.quantity > 0 ? Math.round(total / this.quantity) : 0;
});
BatchLineSchema.set('toJSON', { virtuals: true });
BatchLineSchema.set('toObject', { virtuals: true });

const ProductionBatchSchema = new mongoose.Schema(
  {
    business: {
      type: mongoose.Schema.ObjectId,
      ref: 'Business',
      required: [true, 'Please select a business']
    },
    product: {
      type: mongoose.Schema.ObjectId,
      ref: 'Product',
      required: [true, 'Please select a product']
    },

    lines: {
      type: [BatchLineSchema],
      validate: {
        validator: v => Array.isArray(v) && v.length > 0,
        message: 'Add at least one variant to produce'
      }
    },

    status: { type: String, enum: ['open', 'closed'], default: 'open' },

    // ── Denormalised for the lean list (kept in step in pre-save) ──────────
    /** Total units across all lines. */
    totalQuantity: { type: Number, default: 0 },
    /** Total cost across all lines (paisa) = Σ quantity × unitCost. */
    totalCostPaisa: { type: Number, default: 0 },

    closeEntry: { type: mongoose.Schema.ObjectId, ref: 'JournalEntry' },
    closedAt: { type: Date },

    createdBy: { type: mongoose.Schema.ObjectId, ref: 'User', required: true },
    updatedBy: { type: mongoose.Schema.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

ProductionBatchSchema.index({ business: 1, status: 1 });
ProductionBatchSchema.index({ business: 1, product: 1 });

/** Keep the denormalised totals in step with the lines (cost = Σ cost lines). */
ProductionBatchSchema.pre('save', function () {
  this.totalQuantity = (this.lines || []).reduce((sum, l) => sum + (l.quantity || 0), 0);
  this.totalCostPaisa = (this.lines || []).reduce(
    (sum, l) => sum + (l.costLines || []).reduce((s, c) => s + (c.amountPaisa || 0), 0),
    0
  );
});

export default mongoose.model('ProductionBatch', ProductionBatchSchema);
