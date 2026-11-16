import mongoose from 'mongoose';
import ErrorResponse from './errorResponse.js';

/**
 * Which categories a business sells in, and which one an article is in. The single place the rule lives —
 * the Product hook, the goods-receipt planner and the business update all use it.
 */

/** A business's categories as id strings; an older document falls back to its single legacy field. */
export const categoriesOf = biz =>
  (biz?.categories?.length ? biz.categories : biz?.category ? [biz.category] : []).map(c =>
    String(c._id ?? c)
  );

/** True when `categoryId` is one of the business's categories. */
export const isCategoryOf = (biz, categoryId) => categoriesOf(biz).includes(String(categoryId));

export const NOT_THIS_BUSINESS = "Choose one of this business's categories";

/**
 * Fill or check an article's category against its business. Returns null when fine, or `{ path, message }`
 * to hand to `invalidate`. With no category chosen the article gets the business's first (its default).
 */
export async function resolveProductCategory(product) {
  const biz = await mongoose
    .model('Business')
    .findById(product.business)
    .select('categories category')
    .lean();
  if (!biz) return { path: 'business', message: 'Business not found' };
  const list = categoriesOf(biz);
  if (!product.category) {
    if (!list.length) return { path: 'category', message: 'This business has no category yet' };
    product.category = list[0];
    return null;
  }
  if (!list.includes(String(product.category))) {
    return { path: 'category', message: NOT_THIS_BUSINESS };
  }
  return null;
}

/**
 * Before a business update: categories being removed that articles still use. Returns an ErrorResponse (400)
 * naming the first one with its count, or null. The user fixes one at a time.
 */
export async function blockRemovedCategoriesInUse(business, nextCategoryIds) {
  const next = new Set(nextCategoryIds.map(String));
  const removed = categoriesOf(business).filter(id => !next.has(id));
  for (const id of removed) {
    const count = await mongoose
      .model('Product')
      .countDocuments({ business: business._id, category: id });
    if (count > 0) {
      const name =
        (await mongoose.model('Category').findById(id).select('name').lean())?.name ?? 'it';
      const noun = count === 1 ? 'article is' : 'articles are';
      return new ErrorResponse(
        `${count} ${noun} in ${name} — move ${count === 1 ? 'it' : 'them'} to another category first, then remove it.`,
        400
      );
    }
  }
  return null;
}
