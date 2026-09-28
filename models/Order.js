import mongoose from 'mongoose';
import { ORDER_STATUS, PAYMENT_STATUS, SALES_CHANNELS } from '../utils/constants.js';
import { getNextSequence } from '../utils/sequence.js';
import { pakistanDay } from '../utils/pakistanDay.js';

/** One step in an order's life — what it became, when, by whom, and why. */
const StatusEventSchema = new mongoose.Schema(
  {
    status: { type: String, enum: Object.values(ORDER_STATUS), required: true },
    note: { type: String, trim: true, maxlength: 300 },
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.ObjectId, ref: 'User' }
  },
  { _id: false }
);

/**
 * Money the customer paid us directly (an advance — the payment screenshot) or
 * we paid back (a refund). Each is posted the day it happens, against
 * "Advances from customers", so the money is in the books before the parcel
 * even ships.
 */
const CustomerMoneySchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['advance', 'refund', 'credit'], required: true },
    amountPaisa: { type: Number, required: true, min: 1 },
    /** The money account it went into / came out of — or a partner, personally. */
    account: { type: mongoose.Schema.ObjectId, ref: 'Account' },
    partner: { type: mongoose.Schema.ObjectId, ref: 'Partner' },
    /** Where, as it read at the time ("Meezan bank", "Ali (partner)"). */
    accountName: { type: String },
    date: { type: Date, default: Date.now },
    note: { type: String, trim: true, maxlength: 300 },
    entry: { type: mongoose.Schema.ObjectId, ref: 'JournalEntry', required: true },
    by: { type: mongoose.Schema.ObjectId, ref: 'User' }
  },
  { _id: true }
);

/** Statuses after which the COD is fixed — the courier has it on the airway bill. */
const COD_FROZEN = new Set([
  ORDER_STATUS.DISPATCHED,
  ORDER_STATUS.DELIVERED,
  ORDER_STATUS.RETURNED,
  ORDER_STATUS.EXCHANGED
]);

/** The date field each status stamps, so lists can filter "delivered 1–15 Sep". */
const STATUS_DATE_FIELD = {
  dispatched: 'dispatchedAt',
  delivered: 'deliveredAt',
  returned: 'returnedAt',
  cancelled: 'cancelledAt',
  exchanged: 'exchangedAt'
};

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

/** Work done for this customer on top of (or instead of) stock items. */
const CustomWorkSchema = new mongoose.Schema(
  {
    description: { type: String, required: true, trim: true, maxlength: 300 },
    /** What the customer pays for it (rupees). */
    price: { type: Number, required: true, min: 0 },
    /** Made from scratch — no stock item behind it. */
    fromScratch: { type: Boolean, default: false }
  },
  { _id: true }
);

/** Material bought for this order's custom work — booked the day it was spent. */
const CustomCostSchema = new mongoose.Schema(
  {
    description: { type: String, required: true, trim: true, maxlength: 200 },
    amountPaisa: { type: Number, required: true, min: 1 },
    /** Where the money came from, as it read at the time. */
    accountName: { type: String },
    date: { type: Date, default: Date.now },
    entry: { type: mongoose.Schema.ObjectId, ref: 'JournalEntry', required: true },
    by: { type: mongoose.Schema.ObjectId, ref: 'User' }
  },
  { _id: true }
);

const OrderSchema = new mongoose.Schema(
  {
    /** Sequential, zero-padded, unique — generated in the pre-save hook. */
    orderNumber: { type: String, unique: true },
    /**
     * The order's place in its day — "today's #7" — restarting at midnight in
     * Pakistan, per business. For reading the day's orders at a glance only;
     * `orderNumber` stays the one number that never repeats (search, couriers,
     * phone calls).
     */
    orderDay: { type: String }, // YYYY-MM-DD, Pakistan
    dailySerial: { type: Number },
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
        validator: function (v) {
          return (Array.isArray(v) && v.length > 0) || (this.customWork?.length ?? 0) > 0;
        },
        message: 'An order needs at least one item or custom work'
      }
    },

    // ── Money ──────────────────────────────────────────────────────────────
    customWork: { type: [CustomWorkSchema], default: [] },
    /** Material for the custom work (only people who "See costs" get this back). */
    customCosts: { type: [CustomCostSchema], default: [] },
    /** The write-off posted when the order was cancelled/returned — reversed on reopen. */
    customCostWriteOff: { type: mongoose.Schema.ObjectId, ref: 'JournalEntry' },
    subtotal: { type: Number, default: 0 }, // derived
    advanceAmount: {
      type: Number,
      default: 0,
      min: [0, 'Advance can not be negative']
    },
    total: { type: Number, default: 0 }, // derived (= subtotal)
    /**
     * What the courier collects — total − advance, derived until DISPATCH, then
     * frozen: the courier has printed it, so an advance that arrives later
     * doesn't change it and becomes a refund due instead.
     */
    codAmount: { type: Number, default: 0 },
    /** Advances and refunds, each with its ledger entry. `advanceAmount` is their net. */
    customerMoney: { type: [CustomerMoneySchema], default: [] },
    /**
     * What we owe the customer back (paisa, derived): an advance that came after
     * the COD was fixed, or anything held on an order that won't be sold.
     */
    refundDuePaisa: { type: Number, default: 0 },
    /** Counter sale: the money account the "paid now" went into. */
    counterAccount: { type: mongoose.Schema.ObjectId, ref: 'Account' },
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
    /** Every status change with its optional reason — the order's timeline. */
    statusHistory: { type: [StatusEventSchema], default: [] },
    dispatchedAt: { type: Date },
    deliveredAt: { type: Date },
    returnedAt: { type: Date },
    cancelledAt: { type: Date },
    exchangedAt: { type: Date },
    /** A free note on the order — editable at any status, even after dispatch. */
    note: { type: String, trim: true, maxlength: 1000 },

    // ── Ledger links (Phase 3 accounting) ─────────────────────────────────
    /** The Sale + COGS entry, posted once on delivery. Its presence = "already booked". */
    saleEntry: { type: mongoose.Schema.ObjectId, ref: 'JournalEntry' },
    /** The COD-remittance entry, posted when the courier settles. */
    paymentEntry: { type: mongoose.Schema.ObjectId, ref: 'JournalEntry' },
    /**
     * Counter sale on credit only: how much of the balance owed (`codAmount`) the
     * customer has paid through their party page so far (paisa). Lets part
     * payments land on the order, and a later "Mark paid" book only the rest.
     */
    paidPaisa: { type: Number },
    /**
     * Courier order whose COD was paid on a courier invoice: that invoice's
     * journal entry. Reversing it sets the order back to unpaid; the order
     * itself can't be unmarked on its own.
     */
    courierSettlement: { type: mongoose.Schema.ObjectId, ref: 'JournalEntry' },
    /**
     * Courier's delivery fee, deducted from the remittance (paisa). Captured at
     * DELIVERY, not dispatch — the courier bills by weight, city and outcome, so
     * the real figure is only known once the parcel has landed.
     */
    deliveryChargePaisa: { type: Number },
    /**
     * What the courier billed to bring the parcel back (paisa) — a refused
     * return, or the pickup leg of an exchange. Kept apart from the delivery fee
     * so an exchanged order records both legs.
     */
    returnChargePaisa: { type: Number },
    /**
     * The courier invoice entries that billed this parcel's charges. A charge is
     * open (still to come on an invoice) while its amount above is unset; when
     * an invoice sets it, the entry is kept so reversing that invoice reopens it.
     */
    deliveryChargeEntry: { type: mongoose.Schema.ObjectId, ref: 'JournalEntry' },
    returnChargeEntry: { type: mongoose.Schema.ObjectId, ref: 'JournalEntry' },

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
OrderSchema.index({ business: 1, dispatchedAt: -1 });
OrderSchema.index({ business: 1, deliveredAt: -1 });
OrderSchema.index({ business: 1, refundDuePaisa: 1 });
// Scan-to-find: a courier tracking number resolves to its order. Sparse — most
// orders have no tracking id until they are dispatched.
OrderSchema.index({ business: 1, trackingId: 1 }, { sparse: true });
OrderSchema.index({ 'items.product': 1, 'items.variantId': 1 }); // price-hint lookup

/**
 * Generate the order numbers once, log every status change, and keep the money
 * fields derived. Logging here rather than in each controller means no path that
 * changes a status (status endpoint, exchange, cancel) can skip the timeline.
 * The reason travels in `order.$locals.statusNote`; the actor is `updatedBy`
 * (or `createdBy` for a new order).
 */
OrderSchema.pre('save', async function () {
  if (this.isNew && !this.orderNumber) {
    const seq = await getNextSequence('order');
    this.orderNumber = String(seq).padStart(4, '0');
  }
  if (this.isNew && !this.dailySerial) {
    this.orderDay = pakistanDay(this.createdAt || new Date());
    this.dailySerial = await getNextSequence(`order-day:${this.business}:${this.orderDay}`);
  }

  if (this.isNew || this.isModified('status')) {
    const at = new Date();
    this.statusHistory.push({
      status: this.status,
      note: this.$locals.statusNote || undefined,
      at,
      by: this.isNew ? this.createdBy : this.updatedBy
    });
    const dateField = STATUS_DATE_FIELD[this.status];
    if (dateField) this[dateField] = at;
    this.$locals.statusNote = undefined;
  }

  this.subtotal =
    this.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0) +
    this.customWork.reduce((sum, w) => sum + w.price, 0);
  this.total = this.subtotal;
  deriveCustomerMoney(this);
  this.itemCount = this.items.length + this.customWork.length;
});

/** A walk-in counter sale — its "advance" is the cash taken at the counter. */
export const isCounterSale = order => !order.courier && order.source === SALES_CHANNELS.WALK_IN;

/**
 * Keep advance, COD and refund-due consistent with the customer's money. Held
 * money is the net of advances and refunds; the COD takes it off the total until
 * dispatch; after that, whatever is held beyond what the sale uses is owed back.
 * A cancelled or returned order uses none of it.
 */
function deriveCustomerMoney(order) {
  const totalPaisa = Math.round(order.total * 100);
  if (!isCounterSale(order)) {
    const heldPaisa = order.customerMoney.reduce(
      (s, m) => s + (m.kind === 'advance' ? m.amountPaisa : -m.amountPaisa),
      0
    );
    order.advanceAmount = heldPaisa / 100;
    // Before dispatch the COD follows the advance; frozen after.
    if (order.isNew || !COD_FROZEN.has(order.status)) {
      order.codAmount = Math.max(0, totalPaisa - heldPaisa) / 100;
    }
    const usedPaisa =
      order.status === ORDER_STATUS.CANCELLED ||
      order.status === ORDER_STATUS.RETURNED ||
      order.status === ORDER_STATUS.EXCHANGED
        ? 0
        : totalPaisa - Math.round(order.codAmount * 100);
    order.refundDuePaisa = Math.max(0, heldPaisa - usedPaisa);
    return;
  }
  order.codAmount = Math.max(0, order.total - (order.advanceAmount || 0));
  order.refundDuePaisa = 0;
}

export default mongoose.model('Order', OrderSchema);
