import express from 'express';
import { protect } from '../middlewares/auth.js';
import { can, loadScoped, restrictBusinessToScope } from '../middlewares/permissions.js';
import advancedResults from '../middlewares/advancedResults.js';
import ProductionBatch from '../models/ProductionBatch.js';
import {
  getBatches,
  getBatch,
  createBatch,
  updateBatch,
  closeBatch,
  deleteBatch
} from '../controllers/productionController.js';

const router = express.Router();

router.use(protect);

/**
 * @swagger
 * tags:
 *   - name: Production
 *     description: Stock batches — a product's variants received/produced at cost
 */

/**
 * @swagger
 * /production:
 *   get:
 *     summary: List production batches (lean — article, name, units, total cost)
 *     tags: [Production]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: business, schema: { type: string } }
 *       - { in: query, name: product, schema: { type: string } }
 *       - { in: query, name: status, schema: { type: string, enum: [open, closed] } }
 *     responses:
 *       200: { description: List of batches }
 *   post:
 *     summary: Start a draft batch (one product, several variants with qty + cost)
 *     tags: [Production]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [business, product, lines]
 *             properties:
 *               business: { type: string }
 *               product:  { type: string }
 *               lines:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     variantId: { type: string }
 *                     quantity:  { type: integer }
 *                     salePrice: { type: number, description: Rupees — set on the variant at close }
 *                     costLines:
 *                       type: array
 *                       description: The variant's itemised costs; sum ÷ quantity = unit cost.
 *                       items:
 *                         type: object
 *                         properties:
 *                           label:  { type: string, example: Cloth }
 *                           amount: { type: number, description: Rupees }
 *                           fund:   { type: string, description: "'cash', 'bank', or a supplier party id (→ on credit)" }
 *     responses:
 *       201: { description: Draft batch created }
 */
router
  .route('/')
  .get(
    can('production', 'read'),
    // Lean list: product (article + name), total units, total cost, status. The
    // per-variant lines come from the detail-by-id endpoint.
    advancedResults(
      ProductionBatch,
      { path: 'product', select: 'name articleNumber' },
      ['product'],
      'product totalQuantity totalCostPaisa status closedAt createdAt'
    ),
    getBatches
  )
  .post(can('production', 'create'), restrictBusinessToScope(), createBatch);

/**
 * @swagger
 * /production/{id}/close:
 *   post:
 *     summary: Close the batch — post to inventory, add stock, re-average cost
 *     description: >
 *       Posts Dr Inventory / Cr cash|bank|payable for the whole cost, then per
 *       variant adds the quantity to stock, re-averages the variant's cost, and
 *       sets its sale price. Optional `lines: [{ variantId, salePrice }]` in the
 *       body applies final sale-price adjustments from the close review.
 *     tags: [Production]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: Batch closed — stock added, costs re-averaged }
 *       400: { description: Already closed, or no lines }
 */
router.post('/:id/close', can('production', 'update'), loadScoped(ProductionBatch), closeBatch);

/**
 * @swagger
 * /production/{id}:
 *   get: { summary: Get a batch, tags: [Production], security: [{ bearerAuth: [] }], responses: { 200: { description: Batch } } }
 *   put: { summary: Edit a draft batch (open only), tags: [Production], security: [{ bearerAuth: [] }], responses: { 200: { description: Updated }, 400: { description: Closed } } }
 *   delete: { summary: Delete a draft batch, tags: [Production], security: [{ bearerAuth: [] }], responses: { 200: { description: Deleted }, 400: { description: Closed } } }
 */
router
  .route('/:id')
  .get(can('production', 'read'), loadScoped(ProductionBatch), getBatch)
  .put(can('production', 'update'), loadScoped(ProductionBatch), updateBatch)
  .delete(can('production', 'delete'), loadScoped(ProductionBatch), deleteBatch);

export default router;
