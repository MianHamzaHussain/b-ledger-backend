import { z } from 'zod';

const id = z.string().min(1, 'Required');
const link = z.string().trim().optional();

const codTax = z
  .object({
    registered: z.boolean().optional(),
    whtPercent: z.coerce.number().min(0).max(100).optional(),
    salesTaxPercent: z.coerce.number().min(0).max(100).optional()
  })
  .optional();

export const businessCreateSchema = z.object({
  name: z.string().trim().min(1, 'Please add a business name'),
  category: id,
  storeLink: link,
  facebookLink: link,
  instagramLink: link,
  whatsappNumber: z.string().trim().optional(),
  codTax,
  status: z.enum(['active', 'inactive']).optional()
});

// Update leaves every field optional — a PUT may touch just one.
export const businessUpdateSchema = businessCreateSchema.partial();
