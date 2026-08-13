import mongoose from 'mongoose';
import { ORDER_STATUS, PAYMENT_STATUS, SALES_CHANNELS } from '../utils/constants.js';
import { getNextSequence } from '../utils/sequence.js';

/**
 * One line of an order — a specific SKU at a negotiated price.
 *
 * productName, variantLabel and unitCost are SNAPSHOTS taken at order time.
 * The product may later be renamed, repriced or deleted, but this order's
 * history and its profit (unitPrice − unitCost) must not change retroactively.
 * variantId points back at the embedded Product variant so a return can restock
 * exactly the right size.
 */
const OrderItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.ObjectId, ref: 'Product', required: true },
    variantId: { type: mongoose.Schema.ObjectId, required: true },
    productName: { type: String, required: true },
    variantLabel: { type: String, default: 'Default' },
    quantity: {
      type: Number,
      required: true,
      min: [1, 'Quantity must be at least 1']
    },
    unitPrice: {
      type: Number,
      required: [true, 'Please add a price'],
      min: [0, 'Price can not be negative']
    },
    unitCost: { type: Number, required: true, min: 0 }
  },
  { _id: true }
);

const OrderSchema = new mongoose.Schema(
  {
    /** Sequential, zero-padded, unique — generated in the pre-save hook. */
    orderNumber: { type: String, unique: true },
    business: {
      type: mongoose.Schema.ObjectId,
      ref: 'Business',
      required: [true, 'Please select a business']
    },
    customer: { type: mongoose.Schema.ObjectId, ref: 'Customer', required: true },
    /**
     * The courier this order ships with — a Party of type `courier`, chosen at
     * DISPATCH (a walk-in/counter sale has none). COD is tagged to it, so the
     * courier's pending balance shows on its party statement.
     */
    courier: { type: mongoose.Schema.ObjectId, ref: 'Party' },
    /**
     * The buyer as a running-account Party (type `customer`) — set only for a
     * walk-in/counter sale left unpaid, so the balance owed is sub-ledgered to a
     * name we can chase. A courier order and a paid cash sale leave this empty.
     */
    customerParty: { type: mongoose.Schema.ObjectId, ref: 'Party' },
    /** Which channel the order came in on — for "where do orders come from". */
    source: {
      type: String,
      enum: Object.values(SALES_CHANNELS),
      default: SALES_CHANNELS.OTHER
    },

    // ── Delivery snapshot (immutable per order) ────────────────────────────
    customerName: { type: String, required: [true, 'Please add a customer name'], trim: true },
    contactNumber: { type: String, required: [true, 'Please add a contact number'], trim: true },
    city: { type: String, trim: true },
    deliveryAddress: { type: String, trim: true },
    /**
     * Courier consignment / tracking number, set at dispatch. Searchable and
     * scannable (the courier prints it as a barcode) so a parcel in hand resolves
     * back to its order.
     */
    trackingId: { type: String, trim: true },

    items: {
      type: [OrderItemSchema],
      validate: {
        validator: v => Array.isArray(v) && v.length > 0,
        message: 'An order needs at least one item'
      }
    },

    // ── Money ──────────────────────────────────────────────────────────────
    subtotal: { type: Number, default: 0 }, // derived
    advanceAmount: {
      type: Number,
      default: 0,
      min: [0, 'Advance can not be negative']
    },
    total: { type: Number, default: 0 }, // derived (= subtotal)
    codAmount: { type: Number, default: 0 }, // derived (= total − advance)
    /** Number of line items — denormalised so the list can show it without
     *  shipping (or counting) the whole items array. Derived, like the money. */
    itemCount: { type: Number, default: 0 },

    // ── Two independent status axes ───────────────────────────────────────
    status: {
      type: String,
      enum: Object.values(ORDER_STATUS),
      default: ORDER_STATUS.PENDING
    },
    paymentStatus: {
      type: String,
      enum: Object.values(PAYMENT_STATUS),
      default: PAYMENT_STATUS.UNPAID
    },

    // ── Ledger links (Phase 3 accounting) ─────────────────────────────────
    /** The Sale + COGS entry, posted once on delivery. Its presence = "already booked". */
    saleEntry: { type: mongoose.Schema.ObjectId, ref: 'JournalEntry' },
    /** The COD-remittance entry, posted when the courier settles. */
    paymentEntry: { type: mongoose.Schema.ObjectId, ref: 'JournalEntry' },
    /** Courier's delivery fee, deducted from the remittance (paisa). */
    deliveryChargePaisa: { type: Number },

    // ── Exchange links ────────────────────────────────────────────────────
    /** On the replacement order: the original it replaces. */
    exchangeOf: { type: mongoose.Schema.ObjectId, ref: 'Order' },
    /** On the original order: the replacement created for it. */
    exchangedFor: { type: mongoose.Schema.ObjectId, ref: 'Order' },

    createdBy: { type: mongoose.Schema.ObjectId, ref: 'User', required: true },
    updatedBy: { type: mongoose.Schema.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

OrderSchema.index({ business: 1, status: 1 });
OrderSchema.index({ business: 1, createdAt: -1 });
// Scan-to-find: a courier tracking number resolves to its order. Sparse — most
// orders have no tracking id until they are dispatched.
OrderSchema.index({ business: 1, trackingId: 1 }, { sparse: true });
OrderSchema.index({ 'items.product': 1, 'items.variantId': 1 }); // price-hint lookup

/** Generate the order number once, and keep the money fields derived. */
OrderSchema.pre('save', async function () {
  if (this.isNew && !this.orderNumber) {
    const seq = await getNextSequence('order');
    this.orderNumber = String(seq).padStart(4, '0');
  }

  this.subtotal = this.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
  this.total = this.subtotal;
  this.codAmount = Math.max(0, this.total - (this.advanceAmount || 0));
  this.itemCount = this.items.length;
});

export default mongoose.model('Order', OrderSchema);
