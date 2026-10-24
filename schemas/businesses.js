import { z } from 'zod';
import { LOGO_MAX_CHARS } from '../utils/constants.js';

const id = z.string().min(1, 'Required');
const link = z.string().trim().optional();

/**
 * A logo is a small png/jpeg/webp `data:` image of at most 150 KB. Anything else — an
 * SVG (which can carry script), a remote URL, a different type — is refused, because
 * the app shows it on every screen for everyone assigned to the business. `null`
 * removes the logo.
 */
const logo = z
  .string()
  .max(LOGO_MAX_CHARS, 'The logo is too large — use one under 150 KB')
  .regex(
    /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/,
    'The logo must be a PNG, JPEG or WebP image'
  )
  .nullable()
  .optional();

const brandColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #1a73e8')
  .nullable()
  .optional();

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
  logo,
  brandColor,
  // New articles start with "keep selling when out of stock" on or off.
  defaultAllowOversell: z.boolean().optional(),
  status: z.enum(['active', 'inactive']).optional()
});

// Update leaves every field optional — a PUT may touch just one.
export const businessUpdateSchema = businessCreateSchema.partial();
