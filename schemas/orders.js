import { z } from 'zod';

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

export const orderCreateSchema = z
  .object({
    business: id,
    customerName: z.string().trim().min(1, 'Customer name is required'),
    contactNumber: z.string().trim().min(1, 'Contact number is required'),
    city: z.string().optional(),
    deliveryAddress: z.string().optional(),
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
  status: z.enum(['pending', 'confirmed', 'dispatched', 'delivered', 'cancelled', 'returned']),
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
const replacementOrder = {
  items: z.array(orderItem).default([]),
  customWork: z.array(customWork).max(20).default([]),
  courier: id.optional(),
  customerName: z.string().trim().min(1).optional(),
  contactNumber: z.string().trim().min(1).optional(),
  city: z.string().optional(),
  deliveryAddress: z.string().optional()
};
const hasSomething = [
  v => v.items.length + v.customWork.length > 0,
  { message: 'Add at least one item or custom work', path: ['items'] }
];

/** Swap at the door: the replacement, and the reversal that brings the old one back. */
export const orderSwapSchema = z
  .object({
    ...replacementOrder,
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

export const orderTrackingSchema = z.object({
  trackingId: z.string().optional()
});

export const orderCreditSchema = z.object({
  amount: z.coerce.number().positive('Must be more than 0')
});

/** Paid for (what, how much, from where) — or taken from the material store. */
export const customCostSchema = z.union([
  z.object({
    description: z.string().trim().min(1, 'Describe the cost').max(200),
    amount: z.coerce.number().positive('Must be more than 0'),
    account: z.string().min(1, 'Choose where the money came from')
  }),
  z.object({
    material: z.string().min(1, 'Choose the material'),
    materialQty: z.coerce.number().positive('Enter how much')
  })
]);
