import { z } from 'zod';

export const categoryCreateSchema = z.object({
  name: z.string().trim().min(1, 'Please add a category name'),
  description: z.string().trim().optional(),
  // variantCount is denormalised server-side (pre-validate hook), so it is not
  // accepted from the client — only the options list is.
  variantOptions: z.array(z.string().trim()).optional(),
  status: z.enum(['active', 'inactive']).optional()
});

export const categoryUpdateSchema = categoryCreateSchema.partial();
