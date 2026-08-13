import { z } from 'zod';

const id = z.string().min(1, 'Required');

const line = z.object({
  product: id,
  variantId: id,
  quantity: z.coerce.number().int().min(1, 'Quantity must be at least 1'),
  unitPrice: z.coerce.number().min(0, 'Price can not be negative')
});

export const consignmentCreateSchema = z.object({
  business: id,
  party: id,
  lines: z.array(line).min(1, 'Add at least one product')
});

export const consignmentUpdateSchema = z.object({
  business: id.optional(),
  party: id.optional(),
  lines: z.array(line).min(1, 'Add at least one product')
});

export const consignmentReturnSchema = z.object({
  lineId: id,
  quantity: z.coerce.number().int().min(1, 'Enter a whole quantity')
});

export const consignmentSellSchema = z.object({
  lineId: id,
  quantity: z.coerce.number().int().min(1, 'Enter a whole quantity'),
  unitPrice: z.coerce.number().min(0).optional()
});

export const consignmentPaymentSchema = z.object({
  amount: z.coerce.number().positive('Amount must be greater than zero').optional(),
  method: z.enum(['cash', 'bank']).optional()
});
