import { z } from 'zod';
import { MATERIAL_UNITS } from '../utils/constants.js';

const id = z.string().min(1, 'Required');
const name = z
  .string()
  .trim()
  .min(1, 'Add a name')
  .max(60, 'Name can not be more than 60 characters');
const note = z.string().trim().max(200, 'Note can not be more than 200 characters').optional();
const date = z.union([z.string(), z.date()]).optional();
const quantity = z.coerce.number().positive('Enter a quantity greater than zero');

export const materialCreateSchema = z.object({
  business: id,
  name,
  unit: z.enum(MATERIAL_UNITS),
  lowStockAt: z.coerce.number().min(0).optional(),
  note
});

export const materialUpdateSchema = z.object({
  name: name.optional(),
  unit: z.enum(MATERIAL_UNITS).optional(),
  /** null clears the warning. */
  lowStockAt: z.coerce.number().min(0).nullable().optional(),
  note,
  isActive: z.boolean().optional()
});

export const materialPurchaseSchema = z.object({
  quantity,
  /** What the whole lot cost, in rupees. */
  amount: z.coerce.number().positive('Enter what it cost'),
  onCredit: z.boolean().optional(),
  /** Already on the shelf when the business started — no money moves now. */
  opening: z.boolean().optional(),
  party: id.optional(),
  /** A money account id, or `partner:<id>` — wins over `method`. */
  account: z.string().min(1).optional(),
  method: z.enum(['cash', 'bank']).optional(),
  date,
  note
});

export const materialAdjustSchema = z
  .object({
    kind: z.enum(['wasted', 'count']),
    /** wasted: how much left the shelf. count: how much is really on it. */
    quantity: z.coerce.number().min(0, 'Can not be negative'),
    date,
    note
  })
  .refine(b => b.kind === 'count' || b.quantity > 0, {
    message: 'Enter a quantity greater than zero',
    path: ['quantity']
  });
