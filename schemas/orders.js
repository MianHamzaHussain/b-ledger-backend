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

export const orderCreateSchema = z.object({
  business: id,
  customerName: z.string().trim().min(1, 'Customer name is required'),
  contactNumber: z.string().trim().min(1, 'Contact number is required'),
  city: z.string().optional(),
  deliveryAddress: z.string().optional(),
  advanceAmount: z.coerce.number().min(0).optional(),
  source: source.optional(),
  customerParty: id.optional(),
  newCustomerParty: z.boolean().optional(),
  items: z.array(orderItem).min(1, 'Add at least one item')
});

export const orderUpdateSchema = z.object({
  business: id.optional(),
  customerName: z.string().trim().min(1, 'Customer name is required'),
  contactNumber: z.string().trim().min(1, 'Contact number is required'),
  city: z.string().optional(),
  deliveryAddress: z.string().optional(),
  advanceAmount: z.coerce.number().min(0).optional(),
  source: source.optional(),
  items: z.array(orderItem).min(1, 'Add at least one item')
});

export const orderStatusSchema = z.object({
  status: z.enum(['pending', 'confirmed', 'dispatched', 'delivered', 'cancelled', 'returned']),
  courier: id.optional(),
  /** The courier's bill for the outcome — the delivery fee on `delivered`, the
   *  return fee on `returned`. Optional: usually billed on the courier invoice. */
  deliveryCharge: z.coerce.number().min(0, 'Delivery charge can not be negative').optional(),
  trackingId: z.string().optional(),
  /** Optional reason for the change — shown on the order's timeline. */
  note: z.string().trim().max(300, 'Keep the note under 300 characters').optional()
});

export const orderNoteSchema = z.object({
  note: z.string().trim().max(1000, 'Keep the note under 1000 characters')
});

export const orderPaymentSchema = z.object({
  paymentStatus: z.enum(['unpaid', 'paid'])
});

export const orderExchangeSchema = z.object({
  items: z.array(orderItem).min(1, 'Add at least one replacement item'),
  courier: id.optional(),
  /** What the courier billed to collect the original parcel — usually left for its invoice. */
  returnCharge: z.coerce.number().min(0, 'Return charge can not be negative').optional()
});

export const orderTrackingSchema = z.object({
  trackingId: z.string().optional()
});
