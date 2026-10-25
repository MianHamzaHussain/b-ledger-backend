/**
 * The number Shopify gave an order, as people copy it: "#12,355", "12 355" and "12355" are one
 * order. A leading # and any commas or spaces are dropped; anything else (a store's own prefix,
 * "LX-1042") is kept as typed. Empty stays empty so a cleared box clears the field.
 */
export const cleanShopifyNumber = value =>
  typeof value === 'string' ? value.replace(/^\s*#/, '').replace(/[\s,]/g, '') : value;
