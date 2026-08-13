import express from 'express';
import { protect } from '../middlewares/auth.js';
import { can, loadScoped, restrictBusinessToScope } from '../middlewares/permissions.js';
import advancedResults from '../middlewares/advancedResults.js';
import Product from '../models/Product.js';
import {
  getProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct
} from '../controllers/productController.js';

const router = express.Router();

router.use(protect);

/**
 * @swagger
 * /products:
 *   get:
 *     summary: Get all products
 *     tags: [Products]
 *     description: >
 *       Scoped by business. Pass `business` (the active business) to narrow to
 *       one; scope `own` already limits to the user's assigned businesses.
 *       Search matches product name or article number.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: business, schema: { type: string }, description: Business ObjectId }
 *       - { in: query, name: search,   schema: { type: string }, description: Name or article number }
 *       - { in: query, name: category, schema: { type: string } }
 *       - { in: query, name: status,   schema: { type: string, enum: [active, inactive] } }
 *       - { in: query, name: page,     schema: { type: integer } }
 *       - { in: query, name: limit,    schema: { type: integer } }
 *     responses:
 *       200: { description: List of products }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *   post:
 *     summary: Create a product
 *     tags: [Products]
 *     description: >
 *       Article number and each variant's barcode are auto-generated. Variants
 *       are validated against the chosen subcategory's attributes.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/Product' }
 *           example:
 *             business: 60d0fe4f5311236168a109cc
 *             category: 60d0fe4f5311236168a109dd
 *             name: Embroidered Lawn Suit
 *             lowStockThreshold: 5
 *             variants:
 *               - { label: Unstitched, costPrice: 800, salePrice: 1200, stock: 10 }
 *               - { label: M, costPrice: 1000, salePrice: 1600, stock: 1 }
 *     responses:
 *       201: { description: Product created }
 *       400: { description: Validation error (bad variant/option, missing price) }
 *       403: { description: Not assigned to that business }
 */
router
  .route('/')
  .get(
    can('products', 'read'),
    // Lean list: only the card's fields — article, name, status, and the
    // denormalised variantCount + totalStock. The variants array (labels, costs,
    // stock, barcodes) is fetched by the detail-by-id endpoint on click.
    advancedResults(
      Product,
      null,
      ['name', 'articleNumber'],
      'articleNumber name status variantCount totalStock'
    ),
    getProducts
  )
  .post(can('products', 'create'), restrictBusinessToScope(), createProduct);

/**
 * @swagger
 * /products/{id}:
 *   get:
 *     summary: Get single product
 *     tags: [Products]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Product }
 *       404: { description: Not found, or outside your assigned businesses }
 *   put:
 *     summary: Update a product
 *     tags: [Products]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Product updated }
 *       403: { description: Not assigned to that business }
 *   delete:
 *     summary: Delete a product
 *     tags: [Products]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Product deleted }
 */
router
  .route('/:id')
  .get(can('products', 'read'), loadScoped(Product), getProduct)
  .put(can('products', 'update'), restrictBusinessToScope(), loadScoped(Product), updateProduct)
  .delete(can('products', 'delete'), loadScoped(Product), deleteProduct);

export default router;
