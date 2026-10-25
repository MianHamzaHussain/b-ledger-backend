/**
 * What a business row in the list carries: the card (name, category, status), what the business
 * switcher shows (logo, colour), and `isProtected` — the reset screen decides from the LIST whether
 * a business can be chosen, so a flag that is only on the detail would silently not protect it.
 */
export const BUSINESS_LIST_FIELDS = 'name category status logo brandColor isProtected';
