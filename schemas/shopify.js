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

/** "Type your store address" — any paste is accepted here and cleaned on the server (never trusted as typed). */
export const shopifyStartSchema = z.object({
  business: id,
  shop: z.string().trim().min(1, 'Enter your store address').max(200)
});

/** The install that began on Shopify's side, finished by choosing a business. */
export const shopifyClaimSchema = z.object({
  business: id,
  ticket: z.string().trim().min(16, 'That link is not valid').max(200)
});

/** Admin only: a Shopify app made for one business (custom distribution). */
export const shopifyOwnAppSchema = z.object({
  business: id,
  clientId: z.string().trim().min(8, 'That Client ID looks too short').max(100),
  clientSecret: z.string().trim().min(8, 'That Client secret looks too short').max(300),
  installUrl: z
    .string()
    .trim()
    .url('Paste the install link from the Shopify Dev Dashboard')
    .refine(value => value.startsWith('https://'), 'The install link must start with https://')
});

/** "This Shopify product size is that stock item." */
export const shopifyLinkSchema = z.object({
  business: id,
  shopifyVariantId: z.string().trim().min(1),
  shopifyTitle: z.string().trim().max(200).optional(),
  product: id,
  variantId: id
});
