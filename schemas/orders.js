import { z } from 'zod';
import { cleanShopifyNumber } from '../utils/shopifyNumber.js';
import { ATTEMPT_REASONS } from '../utils/constants.js';

const id = z.string().min(1, 'Required');
const money = z.coerce.number().min(0, 'Can not be negative');
const source = z.enum([
  'shopify',
  'facebook',
  'instagram',
  'tiktok',
  'whatsapp',
  'walk-in',
  'other'
]);

const orderItem = z.object({
  product: id,
  variantId: id,
  quantity: z.coerce.number().int().min(1, 'Quantity must be at least 1'),
  unitPrice: money
});

const customWork = z.object({
  description: z.string().trim().min(1, 'Describe the work').max(300),
  /** Extra charged (positive), a reduction such as "no dupatta" (negative), or 0 for a free change. */
  price: z.coerce.number({ error: 'Enter the price' }),
  fromScratch: z.boolean().optional()
});

/** The Shopify store's own number for this order (reference only), cleaned as people copy it. */
const shopifyOrderNumber = z
  .string()
  .max(40, 'That number is too long')
  .transform(cleanShopifyNumber)
  .pipe(z.string().max(30, 'That number is too long'))
  .optional();

/** A Pakistan calendar day, YYYY-MM-DD. */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date');

export const orderCreateSchema = z
  .object({
    business: id,
    customerName: z.string().trim().min(1, 'Customer name is required'),
    contactNumber: z.string().trim().min(1, 'Contact number is required'),
    city: z.string().optional(),
    deliveryAddress: z.string().optional(),
    customerNote: z.string().trim().max(500, 'Keep the note under 500 characters').optional(),
    shopifyOrderNumber,
    /** Book it for a later day: the order is taken now and an alert fires when the day arrives. */
    bookedFor: day.optional(),
    /** Makes sending this order twice safe — see Order.clientRef. */
    clientRef: z.string().trim().min(1).max(64).optional(),
    /** The customer is blocked and the person chose to create the order anyway. */
    confirmBlocked: z.boolean().optional(),
    advanceAmount: z.coerce.number().min(0).optional(),
    /** Where the advance (or a counter sale's "paid now") went — a money account or partner:<id>. */
    advanceAccount: z.string().optional(),
    source: source.optional(),
    customerParty: id.optional(),
    newCustomerParty: z.boolean().optional(),
    items: z.array(orderItem).default([]),
    customWork: z.array(customWork).max(20).default([])
  })
  .refine(v => v.items.length + v.customWork.length > 0, {
    message: 'Add at least one item or custom work',
    path: ['items']
  });

export const orderUpdateSchema = z
  .object({
    business: id.optional(),
    customerName: z.string().trim().min(1, 'Customer name is required'),
    contactNumber: z.string().trim().min(1, 'Contact number is required'),
    city: z.string().optional(),
    deliveryAddress: z.string().optional(),
    source: source.optional(),
    shopifyOrderNumber,
    /** Moving the order to a blocked customer's number, and the person chose to go ahead. */
    confirmBlocked: z.boolean().optional(),
    items: z.array(orderItem).default([]),
    customWork: z.array(customWork).max(20).default([])
  })
  .refine(v => v.items.length + v.customWork.length > 0, {
    message: 'Add at least one item or custom work',
    path: ['items']
  });

/**
 * A made-from-scratch piece going into stock: what to call the product and its
 * sale price. Left out, the work's own description and price are used.
 */
const scratchPiece = z.object({
  workId: id,
  name: z.string().trim().min(1, 'Name the product').max(120),
  salePrice: z.coerce.number().min(0, 'Price can not be negative')
});

export const orderStatusSchema = z.object({
  status: z.enum([
    'pending',
    'booked',
    'confirmed',
    'dispatched',
    'delivered',
    'cancelled',
    'returned'
  ]),
  /** Required when the new status is `booked`. */
  bookedFor: day.optional(),
  /** Dispatch: book the parcel with the courier's own service (PostEx) instead of typing a tracking number. */
  bookWithCourier: z.boolean().optional(),
  /** Dispatch + book: what the courier's slip prints under Remarks (default: the customer's note). */
  courierRemarks: z
    .string()
    .trim()
    .max(250, 'Keep the courier message under 250 characters')
    .optional(),
  /** Dispatch: use a parcel already made on the courier's own site (its tracking number). */
  attachCourierParcel: z.string().trim().min(3).max(60).optional(),
  /** Dispatch: we deliver it ourselves — instead of a courier. Needs `deliveredBy`. */
  selfDelivery: z.boolean().optional(),
  /** Who is taking it (an employee or anyone). */
  deliveredBy: z.string().trim().max(60, 'Keep the name under 60 characters').optional(),
  /** Delivered by us: was the cash collected? Defaults to yes. */
  collected: z.boolean().optional(),
  /** Where the collected cash (or our delivery cost) goes — a money account; Cash if left out. */
  collectInto: id.optional(),
  /** What the delivery cost us was paid from; Cash if left out. */
  costAccount: id.optional(),
  courier: id.optional(),
  /** The courier's bill for the outcome — the delivery fee on `delivered`, the
   *  return fee on `returned`. Optional: usually billed on the courier invoice. */
  deliveryCharge: z.coerce.number().min(0, 'Delivery charge can not be negative').optional(),
  trackingId: z.string().optional(),
  /** Optional reason for the change — shown on the order's timeline. */
  note: z.string().trim().max(300, 'Keep the note under 300 characters').optional(),
  /** Cancelling or returning a made-from-scratch order puts its pieces into stock. */
  scratchPieces: z.array(scratchPiece).max(20).optional()
});

/** Delivered, then sent back for a refund. Amounts in rupees. */
export const orderRefundReturnSchema = z.object({
  /** Who sent the parcel back: the customer on their own courier, or us (a pickup). */
  returnBy: z.enum(['customer', 'us']),
  /** Their courier's name, for reference — never on our invoice. */
  returnCourierName: z.string().trim().max(60).optional(),
  reversalTrackingId: z.string().trim().max(60).optional(),
  /** Held back from the refund — normally the delivery charge and tax. */
  keep: z.coerce.number().min(0, 'Can not be negative').default(0),
  /** Our part of their shipping (customer), or their part of our pickup (us). */
  shippingShare: z.coerce.number().min(0, 'Can not be negative').optional(),
  scratchPieces: z.array(scratchPiece).max(20).optional(),
  note: z.string().trim().max(300, 'Keep the note under 300 characters').optional()
});

/** Confirm what the courier reports (delivered / returned) for a batch of orders — one tap. */
export const orderCourierConfirmSchema = z.object({
  business: id,
  orderIds: z.array(id).min(1, 'Choose at least one order').max(50, 'Confirm at most 50 at a time')
});

/** One load sheet for a batch handed to the rider. */
export const orderLoadSheetSchema = z.object({
  business: id,
  courier: id,
  orderIds: z.array(id).min(1, 'Choose at least one order').max(100)
});

/** The customer kept some pieces of a delivered order and sent the others back. */
export const orderPartialReturnSchema = z.object({
  lines: z
    .array(
      z.object({
        line: id,
        quantity: z.coerce.number().int('Whole pieces only').min(1, 'At least 1 piece')
      })
    )
    .min(1, 'Choose which items came back'),
  /** Kept back from the refund (rupees) — usually 0; the delivery charge is not deducted by default. */
  keep: money.optional(),
  returnBy: z.enum(['customer', 'us']).optional(),
  returnCourierName: z.string().trim().max(60).optional(),
  reversalTrackingId: z.string().trim().max(60).optional(),
  note: z.string().trim().max(300).optional()
});

/** Print many airway bills at once — up to 100, in the order they were ticked. */
export const orderAirwayBillsSchema = z.object({
  business: id,
  orderIds: z.array(id).min(1, 'Choose at least one order').max(100, 'Print at most 100 at a time')
});

/** Ask every courier about this business's parcels that are out, now. */
export const orderRefreshAllSchema = z.object({ business: id });

/** Book the orders that were waiting for a courier city that has reopened. */
export const orderBookWaitingSchema = z.object({
  business: id,
  orderIds: z.array(id).min(1, 'Choose at least one order').max(100)
});

/** The business's own one-tap courier requests. The server also drops duplicates (any letter case). */
export const orderPhrasesSchema = z.object({
  business: id,
  phrases: z
    .array(
      z
        .string()
        .trim()
        .min(1, 'A request can not be empty')
        .max(60, 'Keep each under 60 characters')
    )
    .max(12, 'Keep it to 12 requests')
});

/** Move a booked order's due day. */
export const orderBookedForSchema = z.object({ bookedFor: day });

/** Empty clears it. Allowed at any status — it changes nothing but the reference. */
export const orderShopifyNumberSchema = z.object({
  shopifyOrderNumber: shopifyOrderNumber.default('')
});

/** An empty note clears it. */
export const orderCustomerNoteSchema = z.object({
  customerNote: z.string().trim().max(500, 'Keep the note under 500 characters')
});

export const orderNoteSchema = z.object({
  note: z.string().trim().max(1000, 'Keep the note under 1000 characters')
});

export const orderPaymentSchema = z.object({
  paymentStatus: z.enum(['unpaid', 'paid'])
});

const reversalTrackingId = z.string().trim().max(60).optional();

/**
 * Exchange, item back first: the customer sends it on a courier of their choice,
 * at their cost — named here for reference, never on our invoice.
 */
export const orderExchangeReturnSchema = z.object({
  returnCourierName: z.string().trim().max(60).optional(),
  /** Their parcel's tracking number, for reference and search. */
  reversalTrackingId,
  note: z.string().trim().max(300, 'Keep the note under 300 characters').optional()
});

/**
 * The replacement is a new order of its own: stock items and/or custom work, a
 * courier of your choice, and the customer's details (a new address, say). The
 * original's credit counts towards it.
 */
const swapOrder = {
  items: z.array(orderItem).default([]),
  customWork: z.array(customWork).max(20).default([]),
  customerName: z.string().trim().min(1).optional(),
  contactNumber: z.string().trim().min(1).optional(),
  city: z.string().optional(),
  deliveryAddress: z.string().optional()
};
/** Sent back first: the replacement may go with any courier. */
const replacementOrder = { ...swapOrder, courier: id.optional() };
const hasSomething = [
  v => v.items.length + v.customWork.length > 0,
  { message: 'Add at least one item or custom work', path: ['items'] }
];

/**
 * Swap at the door: the replacement, and the reversal that brings the old one
 * back. Same courier as the original (it swaps both at once), no COD — a
 * difference the customer owes is paid to us directly, into `differenceAccount`.
 */
export const orderSwapSchema = z
  .object({
    ...swapOrder,
    /** Where the customer paid the difference — a money account or partner:<id>. */
    differenceAccount: z.string().min(1).optional(),
    reversalTrackingId,
    note: z.string().trim().max(300, 'Keep the note under 300 characters').optional()
  })
  .refine(...hasSomething);

export const orderReplacementSchema = z.object(replacementOrder).refine(...hasSomething);

/** An advance the customer sent, or a refund we paid them. */
export const orderMoneySchema = z.object({
  amount: z.coerce.number().positive('Must be more than 0'),
  account: z.string().min(1, 'Choose where the money went'),
  date: z.coerce.date().optional(),
  note: z.string().trim().max(300, 'Keep the note under 300 characters').optional()
});

/** A failed delivery attempt — the reason from a fixed list, and an optional note. */
export const orderAttemptSchema = z.object({
  reason: z.enum(Object.values(ATTEMPT_REASONS), { error: 'Choose why it failed' }),
  note: z.string().trim().max(200, 'Keep the note under 200 characters').optional()
});

export const orderTrackingSchema = z.object({
  trackingId: z.string().optional()
});

export const orderCreditSchema = z.object({
  amount: z.coerce.number().positive('Must be more than 0')
});

/** Paid for (what, how much, from where, to whom) — or taken from the material store. */
export const customCostSchema = z.union([
  z.object({
    description: z.string().trim().min(1, 'Describe the cost').max(200),
    amount: z.coerce.number().positive('Must be more than 0'),
    account: z.string().min(1, 'Choose where the money came from'),
    // Money that leaves must have someone receiving it, so the supplier's Khata can show it.
    party: z.string().min(1, 'Choose who you paid')
  }),
  z.object({
    material: z.string().min(1, 'Choose the material'),
    materialQty: z.coerce.number().positive('Enter how much')
  })
]);
