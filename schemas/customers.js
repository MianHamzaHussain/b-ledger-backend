import { z } from 'zod';

// Edited here; created by an order, by hand (customerCreateSchema) or by an import.
const business = z.string().min(1, 'Choose a business');
const name = z.string().trim().min(1, 'Please add a customer name').max(100);

/** A customer added by hand. */
export const customerCreateSchema = z.object({
  business,
  name,
  phone: z.string().trim().min(1, 'Please add a contact number'),
  city: z.string().trim().max(60).optional(),
  note: z.string().trim().max(200, 'Keep the note under 200 characters').optional()
});

/** One row of an import file — checked for real by the controller, so one bad row can not sink the rest. */
const importRow = z.object({
  line: z.number().int().positive().optional(),
  name: z.string().trim().max(100).default(''),
  phone: z.string().trim().max(40).default(''),
  city: z.string().trim().max(60).optional(),
  note: z.string().trim().max(200).optional()
});

/** Up to 500 rows a request; a bigger file is sent in pieces. */
export const customerImportSchema = z.object({
  business,
  rows: z
    .array(importRow)
    .min(1, 'The file has no rows')
    .max(500, 'Send at most 500 rows at a time')
});

export const customerUpdateSchema = z.object({
  name: z.string().trim().min(1, 'Please add a customer name').optional(),
  phone: z.string().trim().min(1, 'Please add a contact number').optional(),
  city: z.string().trim().optional()
});
