import { z } from 'zod';

/**
 * Zod schemas for the finance record endpoints. Amounts are coerced (a numeric
 * string is accepted) then required positive; ids are non-empty strings that
 * Mongoose casts. Unknown keys are stripped by the validate middleware.
 */
const id = z.string().min(1, 'Required');
const amount = z.coerce.number().positive('Amount must be greater than zero');
const method = z.enum(['cash', 'bank']).optional();
const memo = z.string().optional();
const date = z.union([z.string(), z.date()]).optional();

export const capitalSchema = z.object({
  business: id,
  amount,
  direction: z.enum(['invest', 'drawings']),
  method,
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
  memo,
  date
});

export const paymentSchema = z.object({
  business: id,
  amount,
  party: id,
  direction: z.enum(['pay', 'receive']),
  method,
  memo,
  date
});

export const salarySchema = z.object({
  business: id,
  amount,
  party: id.optional(),
  onCredit: z.boolean().optional(),
  method,
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
  memo,
  date
});

export const loanSchema = z.object({
  business: id,
  amount,
  direction: z.enum(['take', 'repay']),
  party: id,
  method,
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
