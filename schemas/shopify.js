import { z } from 'zod';

const id = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

/**
 * Connect (or re-connect) a store. The Client secret may be left out when only the address or ID is being changed
 * on an existing connection — the saved one is kept; a first connection must have it.
 */
export const shopifyConnectSchema = z.object({
  business: id,
  shop: z.string().trim().min(1, 'Enter the store address').max(200),
  clientId: z.string().trim().min(8, 'That Client ID looks too short').max(100),
  clientSecret: z.string().trim().min(8, 'That Client secret looks too short').max(300).optional()
});

export const shopifyBusinessSchema = z.object({ business: id });

/** "This Shopify product size is that stock item." */
export const shopifyLinkSchema = z.object({
  business: id,
  shopifyVariantId: z.string().trim().min(1),
  shopifyTitle: z.string().trim().max(200).optional(),
  product: id,
  variantId: id
});
