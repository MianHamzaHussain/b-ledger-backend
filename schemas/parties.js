import { z } from 'zod';

import { PARTY_TYPES } from '../utils/constants.js';

const id = z.string().min(1, 'Required');

export const partyCreateSchema = z.object({
  business: id,
  name: z.string().trim().min(1, 'Please add a name'),
  type: z.enum(Object.values(PARTY_TYPES)),
  phone: z.string().trim().optional(),
  note: z.string().trim().optional(),
  isActive: z.boolean().optional()
  // accountId is derived server-side for couriers — never accepted from the body.
});

export const partyUpdateSchema = partyCreateSchema.partial();

export const partyTransactionSchema = z.object({
  direction: z.enum(['gave', 'got']),
  amount: z.coerce
    .number({ error: 'Enter an amount' })
    .positive('Enter an amount greater than zero'),
  method: z.enum(['cash', 'bank']).optional(),
  /** A supplier's bill: the expense account code it was for. */
  category: z.string().optional(),
  date: z.union([z.string(), z.date()]).optional(),
  memo: z.string().trim().max(200).optional()
});
