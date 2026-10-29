import mongoose from 'mongoose';
import {
  ATTEMPT_REASONS,
  ORDER_STATUS,
  PAYMENT_STATUS,
  SALES_CHANNELS
} from '../utils/constants.js';
import { getNextSequence } from '../utils/sequence.js';
import { pakistanDay } from '../utils/pakistanDay.js';
import { cleanShopifyNumber } from '../utils/shopifyNumber.js';
import { normalizeCity } from '../utils/cities.js';

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
    /**
     * advance / refund / credit move real money (each has its entry). The two
     * transfer kinds only move an exchange credit from the original order to its
     * replacement — the money already sits in Advances from customers.
     */
    kind: {
      type: String,
      // kept     — held back from a refund (delivery charge, tax): out
      // shipping — our share of the customer's return shipping, added: in
      enum: ['advance', 'refund', 'credit', 'transfer-in', 'transfer-out', 'kept', 'shipping'],
      required: true
    },
    amountPaisa: { type: Number, required: true, min: 1 },
    /** The money account it went into / came out of — or a partner, personally. */
    account: { type: mongoose.Schema.ObjectId, ref: 'Account' },
    partner: { type: mongoose.Schema.ObjectId, ref: 'Partner' },
    /** Where, as it read at the time ("Meezan bank", "Ali (partner)"). */
    accountName: { type: String },
    date: { type: Date, default: Date.now },
    note: { type: String, trim: true, maxlength: 300 },
    entry: {
      type: mongoose.Schema.ObjectId,
      ref: 'JournalEntry',
      required: function () {
        return !this.kind?.startsWith('transfer');
      }
    },
    by: { type: mongoose.Schema.ObjectId, ref: 'User' }
  },
  { _id: true }
);

/** Kinds that add to what the order holds for the customer. */
const MONEY_IN = new Set(['advance', 'transfer-in', 'shipping']);

/** What the order holds for the customer (paisa): money in, less refunds, credits and transfers out. */
export const heldPaisaOf = order =>
  (order.customerMoney || []).reduce(
    (s, m) => s + (MONEY_IN.has(m.kind) ? m.amountPaisa : -m.amountPaisa),
    0
  );

/**
 * One thing that changed on an order that is NOT a status step — a note, an address, a payment, a
 * tracking number. Append-only; `by` is stamped from the token, never the request body, and a
 * system event (the courier check) has no `by`. See utils/orderActivity.js.
 */
export const ACTIVITY_KINDS = [
  'note',
  'customer-note',
  'details',
  'items',
  'payment',
  'money',
  'courier',
  'cost',
  'booking'
];
/** The log keeps the newest events only, so an order document can not grow without bound. */
export const ACTIVITY_CAP = 300;

const ActivityEventSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ACTIVITY_KINDS, required: true },
    text: { type: String, required: true, trim: true, maxlength: 200 },
    from: { type: String, trim: true, maxlength: 200 },
    to: { type: String, trim: true, maxlength: 200 },
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.ObjectId, ref: 'User' },
    system: { type: Boolean, default: undefined }
  },
  { _id: false }
);

/** One failed try at the door — kept apart from `statusHistory` because the status did not change. */
const DeliveryAttemptSchema = new mongoose.Schema(
  {
    reason: { type: String, enum: Object.values(ATTEMPT_REASONS), required: true },
    note: { type: String, trim: true, maxlength: 200 },
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.ObjectId, ref: 'User' }
  },
  { _id: false }
);

/** Statuses after which the COD is fixed — the courier has it on the airway bill. */
const COD_FROZEN = new Set([
  ORDER_STATUS.DISPATCHED,
  ORDER_STATUS.DELIVERED,
  ORDER_STATUS.RETURNED,
  ORDER_STATUS.EXCHANGED,
  ORDER_STATUS.REFUNDED
]);

/** The date field each status stamps, so lists can filter "delivered 1–15 Sep". */
const STATUS_DATE_FIELD = {
  dispatched: 'dispatchedAt',
  delivered: 'deliveredAt',
  returned: 'returnedAt',
  cancelled: 'cancelledAt',
  exchanged: 'exchangedAt',
  refunded: 'refundedAt'
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
    unitCost: { type: Number, required: true, min: 0 },
    /** Pieces of this line that were not on the shelf when it was taken (article keeps selling). */
    oversold: { type: Number, default: 0, min: 0 },
    /** Delivered with no cost known yet (nothing had arrived) — profit on it is overstated. */
    costUnknown: { type: Boolean, default: false }
  },
  { _id: true }
);

/** Work done for this customer on top of (or instead of) stock items. */
const CustomWorkSchema = new mongoose.Schema(
  {
    description: { type: String, required: true, trim: true, maxlength: 300 },
    /** What it adds to the price (rupees) — negative for a reduction ("no dupatta"). */
    price: { type: Number, required: true },
    /** Made from scratch — no stock item behind it. */
    fromScratch: { type: Boolean, default: false }
  },
  { _id: true }
);

/** Material bought for this order's custom work — booked the day it was spent. */
const CustomCostSchema = new mongoose.Schema(
  {
    description: { type: String, required: true, trim: true, maxlength: 200 },
    // 0 is possible for material the store holds at no cost.
    amountPaisa: { type: Number, required: true, min: 0 },
    /** Taken from the raw-material store rather than paid for: how much of what. */
    material: { type: mongoose.Schema.ObjectId, ref: 'Material' },
    materialQty: { type: Number },
    /** Where the money came from, as it read at the time. */
    accountName: { type: String },
    /** Who it was paid to (a supplier), and their name as it read at the time. */
    paidTo: { type: mongoose.Schema.ObjectId, ref: 'Party' },
    paidToName: { type: String },
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
    // Stored as one canonical spelling ("lhr" → Lahore) so the courier report
    // groups a place once. A setter, so create, edit and update queries all agree.
    city: { type: String, trim: true, set: normalizeCity },
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
    /** Every other change after the order was taken (R9-4) — who, when, from → to. */
    activity: { type: [ActivityEventSchema], default: [] },
    /**
     * Failed tries while the parcel was out. `attemptsTracked` is set at dispatch,
     * so an order sent before staff could log attempts is not mistaken for one
     * that was delivered first time — the report counts only tracked parcels.
     */
    attemptsTracked: { type: Boolean, default: false },
    deliveryAttempts: { type: [DeliveryAttemptSchema], default: [] },
    dispatchedAt: { type: Date },
    deliveredAt: { type: Date },
    returnedAt: { type: Date },
    cancelledAt: { type: Date },
    exchangedAt: { type: Date },
    refundedAt: { type: Date },
    /**
     * A reference the app makes up when it starts an order (a random id). Sending the
     * same one again — a double tap, or an order saved on a phone while offline and
     * sent twice — returns the order already made instead of making another.
     */
    clientRef: { type: String, trim: true, maxlength: 64 },
    /**
     * The customer's request, taken with the order ("gift pack", "call before
     * delivery"). Distinct from `note`, which the team keeps afterwards (shown as the
     * order's "Reason": courier, dispatch, return details). Editable at any status.
     */
    customerNote: { type: String, trim: true, maxlength: 500 },
    /**
     * The number the Shopify store gave this order — a reference only, so the two series (ours and
     * the store's) can be traced to each other. Never used to number anything here.
     */
    /**
     * A booked order's due day (YYYY-MM-DD, a Pakistan day). Only meaningful while the status is
     * `booked`; kept afterwards as a record of what was promised.
     */
    bookedFor: { type: String, match: [/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-12-19'] },
    /** The day the "due" alert was last sent — makes the daily reminder once-only per day. */
    bookingAlertedOn: { type: String },
    /**
     * We deliver this parcel ourselves — no courier, so no COD tax and no courier invoice. Set at
     * dispatch, with `deliveredBy` (an employee or anyone: a label, not a user account).
     */
    selfDelivery: { type: Boolean, default: false },
    /**
     * The parcel as the courier's own service knows it (PostEx): booked from the dispatch dialog,
     * then kept up to date by the status check. `lockedAt` stops a double tap booking two parcels.
     */
    courierBooking: {
      type: new mongoose.Schema(
        {
          provider: { type: String },
          trackingNumber: { type: String },
          bookedAt: { type: Date },
          lockedAt: { type: Date },
          /** The courier's own words for where it is: "Booked", "Out For Delivery"… */
          courierStatus: { type: String },
          courierStatusAt: { type: Date },
          history: { type: [{ code: String, message: String, _id: false }], default: undefined },
          lastSyncAt: { type: Date },
          /** What the courier says it charged — rupees. Filled in when it reports delivered/returned. */
          fee: { type: Number },
          tax: { type: Number },
          /** Waiting for a person's tap: the courier says it was delivered / returned. */
          confirmable: { type: String, enum: ['delivered', 'returned'] },
          /** What the courier was given to print: the Remarks box and the article line. */
          remarks: { type: String },
          sentContents: { type: String }
        },
        { _id: false }
      )
    },
    deliveredBy: { type: String, trim: true, maxlength: 60 },
    /** A self-delivered parcel's cash, taken at the door into this money account. */
    selfCollectAccount: { type: mongoose.Schema.ObjectId, ref: 'Account' },
    shopifyOrderNumber: { type: String, trim: true, maxlength: 30, set: cleanShopifyNumber },
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
    /**
     * On a swap-at-the-door replacement: the courier that delivered the original
     * swaps it at the door, so this order keeps that courier and collects no COD —
     * any difference is paid to us directly, as an advance.
     */
    isSwap: { type: Boolean, default: false },
    /** On the original order: the replacement created for it. */
    exchangedFor: { type: mongoose.Schema.ObjectId, ref: 'Order' },
    /**
     * The courier's reversal tracking number — the pickup that brings the old item
     * back. It is a parcel of its own (and charged), so it must be findable.
     */
    reversalTrackingId: { type: String, trim: true },
    /** Swap at the door: the replacement went out; the old item is still on its way back. */
    awaitingReturn: { type: Boolean, default: false },
    /**
     * A refund return: who sent the parcel back. `customer` — their own courier
     * (named here, for reference), never on our invoice; `us` — a pickup on our
     * courier, billed on its invoice. `sharePaisa` is the part the other side
     * agreed to carry.
     */
    returnShipping: {
      by: { type: String, enum: ['customer', 'us'] },
      courierName: { type: String, trim: true, maxlength: 60 },
      sharePaisa: { type: Number, min: 0 }
    },
    /**
     * Made-from-scratch pieces that went into stock when the order was cancelled,
     * returned or refunded — each its own product, so a later customer can buy it.
     * Reopening the order takes them back out (if still unsold).
     */
    scratchStock: [
      {
        product: { type: mongoose.Schema.ObjectId, ref: 'Product' },
        variantId: { type: mongoose.Schema.ObjectId },
        name: { type: String },
        costPaisa: { type: Number },
        created: { type: Boolean },
        entry: { type: mongoose.Schema.ObjectId, ref: 'JournalEntry' }
      }
    ],

    createdBy: { type: mongoose.Schema.ObjectId, ref: 'User', required: true },
    updatedBy: { type: mongoose.Schema.ObjectId, ref: 'User' }
  },
  {
    timestamps: true,
    // The activity log is read through the order's merged `timeline` (cost events filtered by who is
    // asking). Every other reply that returns the order must not carry the raw array, or a cost event
    // would reach someone who may not see costs.
    toJSON: {
      transform: (_doc, ret) => {
        delete ret.activity;
        return ret;
      }
    }
  }
);

OrderSchema.index({ business: 1, status: 1 });
OrderSchema.index({ business: 1, createdAt: -1 });
OrderSchema.index({ business: 1, dispatchedAt: -1 });
OrderSchema.index({ business: 1, deliveredAt: -1 });
OrderSchema.index({ business: 1, refundDuePaisa: 1 });
// Scan-to-find: a courier tracking number resolves to its order. Sparse — most
// orders have no tracking id until they are dispatched.
// Unique per business, but only for orders that carry a reference. A *partial* index,
// not a sparse one: a sparse compound index still indexes every order (it has a
// business), so two orders without a reference would collide.
OrderSchema.index(
  { business: 1, clientRef: 1 },
  { unique: true, partialFilterExpression: { clientRef: { $type: 'string' } } }
);
OrderSchema.index({ business: 1, trackingId: 1 }, { sparse: true });
OrderSchema.index({ business: 1, reversalTrackingId: 1 }, { sparse: true });
OrderSchema.index({ business: 1, shopifyOrderNumber: 1 }, { sparse: true });
// The courier status check: dispatched parcels that have a courier booking.
OrderSchema.index({ status: 1, 'courierBooking.provider': 1 });
// The reminder job's query: booked orders by due day, across businesses.
OrderSchema.index({ status: 1, bookedFor: 1 });
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

  if (this.activity.length > ACTIVITY_CAP) this.activity = this.activity.slice(-ACTIVITY_CAP);

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
    const heldPaisa = heldPaisaOf(order);
    order.advanceAmount = heldPaisa / 100;
    // Before dispatch the COD follows the advance; frozen after.
    if (order.isNew || !COD_FROZEN.has(order.status)) {
      order.codAmount = Math.max(0, totalPaisa - heldPaisa) / 100;
    }
    const usedPaisa =
      order.status === ORDER_STATUS.CANCELLED ||
      order.status === ORDER_STATUS.RETURNED ||
      order.status === ORDER_STATUS.EXCHANGED ||
      order.status === ORDER_STATUS.REFUNDED
        ? 0
        : totalPaisa - Math.round(order.codAmount * 100);
    order.refundDuePaisa = Math.max(0, heldPaisa - usedPaisa);
    return;
  }
  order.codAmount = Math.max(0, order.total - (order.advanceAmount || 0));
  order.refundDuePaisa = 0;
}

export default mongoose.model('Order', OrderSchema);
