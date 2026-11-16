import Category from '../models/Category.js';
import Business from '../models/Business.js';
import Product from '../models/Product.js';
import {
  createCrudHandlers,
  blockIfReferencedBy,
  blockIfAnyReference
} from '../utils/crudController.js';

/**
 * Categories — standard CRUD. A category is refused deletion while any business
 * lists it or any article is in it.
 *
 * @route  GET    /api/v1/categories      (categories:read)
 * @route  GET    /api/v1/categories/:id  (categories:read)
 * @route  POST   /api/v1/categories      (categories:create)
 * @route  PUT    /api/v1/categories/:id  (categories:update)
 * @route  DELETE /api/v1/categories/:id  (categories:delete)
 */
const handlers = createCrudHandlers({
  model: Category,
  beforeDelete: blockIfAnyReference([
    blockIfReferencedBy(Business, 'categories', 'business'),
    // TODO(contract round): drop with the legacy field. Covers a business not yet backfilled.
    blockIfReferencedBy(Business, 'category', 'business'),
    blockIfReferencedBy(Product, 'category', 'article')
  ])
});

export const {
  getAll: getCategories,
  getOne: getCategory,
  create: createCategory,
  update: updateCategory,
  remove: deleteCategory
} = handlers;
