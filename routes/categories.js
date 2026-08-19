import express from 'express';
import { protect } from '../middlewares/auth.js';
import { can, loadScoped } from '../middlewares/permissions.js';
import advancedResults from '../middlewares/advancedResults.js';
import { validate } from '../middlewares/validate.js';
import Category from '../models/Category.js';
import { categoryCreateSchema, categoryUpdateSchema } from '../schemas/categories.js';
import {
  getCategories,
  getCategory,
  createCategory,
  updateCategory,
  deleteCategory
} from '../controllers/categoryController.js';

const router = express.Router();

router.use(protect);

/**
 * @swagger
 * /categories:
 *   get:
 *     summary: Get all categories
 *     tags: [Categories]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: search, schema: { type: string } }
 *       - { in: query, name: status, schema: { type: string, enum: [active, inactive] } }
 *       - { in: query, name: page,   schema: { type: integer } }
 *       - { in: query, name: limit,  schema: { type: integer } }
 *     responses:
 *       200: { description: List of categories }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *   post:
 *     summary: Create a category
 *     tags: [Categories]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/Category' }
 *           example:
 *             name: Clothing
 *             description: Apparel and fashion
 *     responses:
 *       201: { description: Category created }
 *       400: { description: Validation error or duplicate name }
 */
router
  .route('/')
  .get(
    can('categories', 'read'),
    // Lean list: name + variant count only. Description and the variant menu
    // come from the detail-by-id endpoint.
    advancedResults(Category, null, ['name', 'description'], 'name status variantCount'),
    getCategories
  )
  .post(can('categories', 'create'), validate(categoryCreateSchema), createCategory);

/**
 * @swagger
 * /categories/{id}:
 *   get:
 *     summary: Get single category
 *     tags: [Categories]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Category }
 *       404: { description: Category not found }
 *   put:
 *     summary: Update a category
 *     tags: [Categories]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Category updated }
 *   delete:
 *     summary: Delete a category
 *     tags: [Categories]
 *     description: >
 *       Refused with 400 if any business still references this category —
 *       reassign those businesses first.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Category deleted }
 *       400: { description: Still referenced by one or more businesses }
 */
router
  .route('/:id')
  .get(can('categories', 'read'), loadScoped(Category), getCategory)
  .put(
    can('categories', 'update'),
    loadScoped(Category),
    validate(categoryUpdateSchema),
    updateCategory
  )
  .delete(can('categories', 'delete'), loadScoped(Category), deleteCategory);

export default router;
