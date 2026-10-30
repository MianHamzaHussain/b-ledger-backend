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

/** A courier's connection to its service. The key only goes in — see the controller. */
export const courierConnectionSchema = z.object({
  provider: z.enum(['postex', 'tcs']).optional(),
  token: z.string().trim().min(8, 'That key looks too short').max(300).optional(),
  /** TCS signs in with four values, not one key — saved together, encrypted, and never shown again. */
  credentials: z
    .object({
      clientId: z.string().trim().min(1, 'Enter the client id').max(100),
      clientSecret: z.string().trim().min(1, 'Enter the client secret').max(300),
      username: z.string().trim().min(1, 'Enter the username').max(100),
      password: z.string().trim().min(1, 'Enter the password').max(200)
    })
    .optional(),
  accountNumber: z.string().trim().max(12).optional(),
  serviceCode: z.string().trim().max(6).optional(),
  pickupAddressCode: z.string().trim().max(60).optional(),
  pickupAddressLabel: z.string().trim().max(200).optional(),
  isEnabled: z.boolean().optional(),
  /** Mark delivered / returned automatically from the courier (two matching checks). */
  autoConfirm: z.boolean().optional(),
  /** Record the courier's payments into its wallet account (off until the first batch is checked). */
  recordPayments: z.boolean().optional(),
  /** Follow parcels whose tracking number was typed in by hand (on unless switched off). */
  adoptTyped: z.boolean().optional()
});

/** A person's balance from before the business started on B Ledger. */
export const partyOpeningSchema = z.object({
  /** true — they owed the business; false — the business owed them. */
  owesUs: z.boolean(),
  amount: z.coerce
    .number({ error: 'Enter an amount' })
    .positive('Enter an amount greater than zero'),
  date: z.union([z.string(), z.date()]).optional()
});

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
  /** Optional — some courier invoices carry none; the tracking numbers are what settle. */
  invoiceNumber: z
    .string()
    .trim()
    .max(60, 'Invoice number is too long')
    .optional()
    .transform(v => v || undefined),
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
