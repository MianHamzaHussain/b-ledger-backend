import Category from '../models/Category.js';
import Business from '../models/Business.js';
import { createCrudHandlers, blockIfReferencedBy } from '../utils/crudController.js';

/**
 * Categories — standard CRUD. A category is refused deletion while any business
 * still points at it (products inherit their category from the business, so the
 * business guard covers products transitively).
 *
 * @route  GET    /api/v1/categories      (categories:read)
 * @route  GET    /api/v1/categories/:id  (categories:read)
 * @route  POST   /api/v1/categories      (categories:create)
 * @route  PUT    /api/v1/categories/:id  (categories:update)
 * @route  DELETE /api/v1/categories/:id  (categories:delete)
 */
const handlers = createCrudHandlers({
  model: Category,
  beforeDelete: blockIfReferencedBy(Business, 'category', 'business')
});

export const {
  getAll: getCategories,
  getOne: getCategory,
  create: createCategory,
  update: updateCategory,
  remove: deleteCategory
} = handlers;
