import { z } from 'zod';

// Customers are upserted from orders, never created via a form — only edited.
export const customerUpdateSchema = z.object({
  name: z.string().trim().min(1, 'Please add a customer name').optional(),
  phone: z.string().trim().min(1, 'Please add a contact number').optional(),
  city: z.string().trim().optional()
});
