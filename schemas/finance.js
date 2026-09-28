import { z } from 'zod';

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
const date = z.union([z.string(), z.date()]).optional();

export const capitalSchema = z.object({
  business: id,
  amount,
  direction: z.enum(['invest', 'drawings']),
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
