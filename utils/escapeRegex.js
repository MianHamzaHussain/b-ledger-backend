/** Make typed text safe to use inside a RegExp — what a person types is a literal, never a pattern. */
export const escapeRegex = text => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
