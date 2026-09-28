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
  /** A money account id, or `partner:<id>` — wins over `method`. */
  account: z.string().min(1).optional(),
  /** A supplier's bill: the expense account code it was for. */
  category: z.string().optional(),
  /** An employee payment: salary (default) or an advance against later salary. */
  purpose: z.enum(['salary', 'advance']).optional(),
  /** An employee's salary: how much of their outstanding advance to cut from it. */
  deductAdvance: z.coerce.number().min(0, 'Can not be negative').optional(),
  date: z.union([z.string(), z.date()]).optional(),
  memo: z.string().trim().max(200).optional()
});

/** A courier's invoice — what it paid (COD per order) and billed (charge per parcel). */
export const courierInvoiceSchema = z.object({
  invoiceNumber: z
    .string()
    .trim()
    .min(1, 'Enter the invoice number')
    .max(60, 'Invoice number is too long'),
  invoiceDate: z.union([z.string(), z.date()]).optional(),
  /** What actually arrived — 0 on a week the courier only deducted charges. */
  received: z.coerce.number().min(0, 'Can not be negative').default(0),
  /** The money account it arrived in (id or `partner:<id>`), when anything did. */
  account: z.string().min(1).optional(),
  /** Orders whose COD this invoice paid. */
  cod: z.array(id).default([]),
  /** Charges this invoice billed, per parcel. */
  charges: z
    .array(
      z.object({
        order: id,
        kind: z.enum(['delivery', 'return']),
        amount: z.coerce.number().min(0, 'A charge can not be negative')
      })
    )
    .default([]),
  memo: z.string().trim().max(200).optional()
});
