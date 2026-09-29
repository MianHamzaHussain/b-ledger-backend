import express from 'express';
import { protect } from '../middlewares/auth.js';
import { can, loadScoped, restrictBusinessToScope, hideCosts } from '../middlewares/permissions.js';
import { validate } from '../middlewares/validate.js';
import advancedResults from '../middlewares/advancedResults.js';
import Material from '../models/Material.js';
import {
  materialCreateSchema,
  materialUpdateSchema,
  materialPurchaseSchema,
  materialAdjustSchema
} from '../schemas/materials.js';
import {
  getMaterials,
  getMaterial,
  createMaterial,
  updateMaterial,
  deleteMaterial,
  buyMaterial,
  adjustMaterial,
  undoMaterialMove,
  MATERIAL_LIST_FIELDS
} from '../controllers/materialController.js';

const router = express.Router();

router.use(protect);
// Quantities are for anyone keeping the store; what material cost is a cost.
router.use(hideCosts);

/**
 * @swagger
 * tags:
 *   - name: Materials
 *     description: Raw materials bought in bulk, kept as stock, used by production batches
 */

/**
 * @swagger
 * /materials:
 *   get:
 *     summary: List raw materials (stock on hand, average unit cost)
 *     tags: [Materials]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: business, schema: { type: string } }
 *       - { in: query, name: search, schema: { type: string } }
 *     responses:
 *       200: { description: List of materials }
 *   post:
 *     summary: Add a material (no stock — buy it in)
 *     tags: [Materials]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Created }
 */
router
  .route('/')
  .get(
    can('materials', 'read'),
    advancedResults(Material, null, ['name'], MATERIAL_LIST_FIELDS),
    getMaterials
  )
  .post(
    can('materials', 'create'),
    restrictBusinessToScope(),
    validate(materialCreateSchema),
    createMaterial
  );

/**
 * @swagger
 * /materials/{id}/purchases:
 *   post:
 *     summary: Buy material into stock — Dr Raw materials / Cr money or supplier
 *     tags: [Materials]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Bought — stock and average cost updated }
 */
router.post(
  '/:id/purchases',
  can('materials', 'create'),
  loadScoped(Material),
  validate(materialPurchaseSchema),
  buyMaterial
);

/**
 * @swagger
 * /materials/{id}/adjust:
 *   post:
 *     summary: Record waste, or a shelf count that differed
 *     tags: [Materials]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Adjusted }
 */
router.post(
  '/:id/adjust',
  can('materials', 'update'),
  loadScoped(Material),
  validate(materialAdjustSchema),
  adjustMaterial
);

/**
 * @swagger
 * /materials/{id}/moves/{moveId}:
 *   delete:
 *     summary: Undo the latest purchase or adjustment
 *     tags: [Materials]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Undone }
 */
router.delete(
  '/:id/moves/:moveId',
  can('materials', 'update'),
  loadScoped(Material),
  undoMaterialMove
);

/**
 * @swagger
 * /materials/{id}:
 *   get: { summary: A material with its history, tags: [Materials], security: [{ bearerAuth: [] }], responses: { 200: { description: Material } } }
 *   put: { summary: Edit a material, tags: [Materials], security: [{ bearerAuth: [] }], responses: { 200: { description: Updated } } }
 *   delete: { summary: Delete a material with no history, tags: [Materials], security: [{ bearerAuth: [] }], responses: { 200: { description: Deleted } } }
 */
router
  .route('/:id')
  .get(can('materials', 'read'), loadScoped(Material), getMaterial)
  .put(
    can('materials', 'update'),
    loadScoped(Material),
    validate(materialUpdateSchema),
    updateMaterial
  )
  .delete(can('materials', 'delete'), loadScoped(Material), deleteMaterial);

export default router;
