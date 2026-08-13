import { z } from 'zod';

const id = z.string().min(1, 'Required');
const amount = z.coerce.number().positive('Amount must be greater than zero');
const method = z.enum(['cash', 'bank']).optional();

export const partnerCreateSchema = z.object({
  business: id,
  name: z.string().trim().min(1, 'Please add a name').max(100, 'Name is too long'),
  sharePercent: z.coerce.number().min(0).max(100).optional(),
  phone: z.string().optional(),
  note: z.string().max(200, 'Note is too long').optional(),
  isActive: z.boolean().optional()
});

export const partnerUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  sharePercent: z.coerce.number().min(0).max(100).optional(),
  phone: z.string().optional(),
  note: z.string().max(200).optional(),
  isActive: z.boolean().optional()
});

export const distributeSchema = z.object({ business: id, amount });

/** invest / withdraw — amount and where it moves (business comes from the resource). */
export const capitalMoveSchema = z.object({ amount, method });
