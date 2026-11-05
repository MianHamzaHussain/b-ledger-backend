import { z } from 'zod';
import { parseBusinessDate } from '../utils/pakistanDay.js';
import { COURIER_WALLET_TABS } from '../utils/constants.js';

/**
 * Zod schemas for the finance record endpoints. Amounts are coerced (a numeric
 * string is accepted) then required positive; ids are non-empty strings that
 * Mongoose casts. Unknown keys are stripped by the validate middleware.
 */
const id = z.string().min(1, 'Required');
const amount = z.coerce.number().positive('Amount must be greater than zero');
const method = z.enum(['cash', 'bank']).optional();
/** Where the money went or came from: a money account id, or `partner:<id>`. Wins over `method`. */
const account = z.string().min(1).optional();
const memo = z.string().optional();
// A bare YYYY-MM-DD is that Pakistan day (not midnight UTC); a full timestamp is kept.
const date = z
  .union([z.string(), z.date()])
  .transform(v => parseBusinessDate(v))
  .optional();

export const capitalSchema = z.object({
  business: id,
  amount,
  direction: z.enum(['invest', 'drawings']),
  /** What an owner withdrawal was for — kept on the entry so the owner report can total it. */
  purpose: z.enum(['home', 'personal']).optional(),
  method,
  account,
  memo,
  date
});

export const expenseSchema = z.object({
  business: id,
  amount,
  category: z.string().optional(),
  party: id.optional(),
  product: id.optional(),
  onCredit: z.boolean().optional(),
  method,
  account,
  memo,
  date
});

export const paymentSchema = z.object({
  business: id,
  amount,
  party: id,
  direction: z.enum(['pay', 'receive']),
  method,
  account,
  memo,
  date
});

export const salarySchema = z.object({
  business: id,
  amount,
  party: id.optional(),
  onCredit: z.boolean().optional(),
  /** How much of the employee's outstanding advance to cut from this salary. */
  deductAdvance: z.coerce.number().min(0).optional(),
  method,
  account,
  memo,
  date
});

export const manualSchema = z.object({
  business: id,
  amount,
  debitAccount: id,
  creditAccount: id,
  memo,
  date
});

export const assetSchema = z.object({
  business: id,
  amount,
  onCredit: z.boolean().optional(),
  party: id.optional(),
  method,
  account,
  memo,
  date
});

export const loanSchema = z.object({
  business: id,
  amount,
  direction: z.enum(['take', 'repay']),
  party: id,
  method,
  account,
  interest: z.coerce.number().min(0, 'Interest can not be negative').optional(),
  memo,
  date
});

export const depreciationSchema = z.object({
  business: id,
  amount,
  memo,
  date
});

export const closeSchema = z.object({
  business: id,
  memo,
  date
});

export const moneyAccountCreateSchema = z.object({
  business: id,
  name: z
    .string()
    .trim()
    .min(1, 'Give the account a name')
    .max(60, 'Keep the name under 60 characters'),
  kind: z.enum(['cash', 'bank', 'wallet']),
  number: z.string().trim().max(40, 'Number is too long').optional()
});

export const moneyAccountUpdateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Give the account a name')
    .max(60, 'Keep the name under 60 characters')
    .optional(),
  number: z.string().trim().max(40, 'Number is too long').optional(),
  isActive: z.boolean().optional()
});

export const transferSchema = z.object({
  business: id,
  from: id,
  to: id,
  amount,
  memo,
  date
});

// ── Query strings (GET) — checked by validateQuery before the controller ─────────────────────────────

const objectId = (message = 'Invalid id') => z.string().regex(/^[0-9a-fA-F]{24}$/, message);
const business = z
  .string({ error: 'Select a business' })
  .regex(/^[0-9a-fA-F]{24}$/, 'Select a business');

/** The cash book: `cash` / `bank` (the original two), a money account id, or a partner's running account. */
export const cashbookQuerySchema = z.object({
  business,
  account: z
    .string()
    .regex(
      /^(cash|bank|partner:[0-9a-fA-F]{24}|[0-9a-fA-F]{24})$/,
      'Choose one of this business’s money accounts'
    )
    .optional(),
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional()
});

/** Where the courier's wallet stands. */
export const courierWalletQuerySchema = z.object({
  business,
  account: objectId('Choose the courier wallet')
});

/** A page of the courier's wallet, for one tab. `search` is a plain word, never a pattern (the server escapes it). */
export const courierWalletParcelsQuerySchema = courierWalletQuerySchema.extend({
  tab: z
    .enum(COURIER_WALLET_TABS, { error: 'Choose all, paid, upcoming or charges' })
    .default('all'),
  search: z.string().trim().max(100, 'Search for up to 100 characters').optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25)
});

/** Which courier a receipt (or the list of receipts) is for. */
export const courierReceiptQuerySchema = z.object({
  business,
  courier: objectId('Choose the courier')
});
