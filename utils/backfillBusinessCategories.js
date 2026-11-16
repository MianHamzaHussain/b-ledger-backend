import Business from '../models/Business.js';

/**
 * Round 15: a business used to have one `category`; it now has `categories` (the first is the default). Every
 * stored business that still has only the old field gets `categories: [category]`. Written against the raw
 * collection so no hook or validator interferes. Safe to run twice: the second run finds nothing.
 *
 * `apply: false` (the default) only counts.
 */
export const backfillBusinessCategories = async ({ apply = false } = {}) => {
  const filter = {
    category: { $exists: true, $ne: null },
    $or: [{ categories: { $exists: false } }, { categories: { $size: 0 } }]
  };
  const businesses = await Business.collection.countDocuments(filter);
  if (apply && businesses) {
    await Business.collection.updateMany(filter, [{ $set: { categories: ['$category'] } }]);
  }
  return { businesses };
};
