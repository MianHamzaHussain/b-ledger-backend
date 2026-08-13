import express from 'express';
import { protect } from '../middlewares/auth.js';
import { can, loadScoped, restrictBusinessToScope } from '../middlewares/permissions.js';
import advancedResults from '../middlewares/advancedResults.js';
import { validate } from '../middlewares/validate.js';
import {
  consignmentCreateSchema,
  consignmentUpdateSchema,
  consignmentReturnSchema,
  consignmentSellSchema,
  consignmentPaymentSchema
} from '../schemas/consignments.js';
import Consignment from '../models/Consignment.js';
import {
  getConsignments,
  getConsignment,
  createConsignment,
  updateConsignment,
  deleteConsignment,
  returnLine,
  sellLine,
  recordPayment
} from '../controllers/consignmentController.js';

const router = express.Router();

router.use(protect);

/**
 * @swagger
 * tags:
 *   - name: Consignments
 *     description: Sale or return — goods out with a reseller until kept or returned
 */

/**
 * @swagger
 * /consignments:
 *   get:
 *     summary: List consignments (lean)
 *     tags: [Consignments]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: business, schema: { type: string } }
 *       - { in: query, name: party, schema: { type: string } }
 *       - { in: query, name: status, schema: { type: string, enum: [out, settled] } }
 *     responses:
 *       200: { description: List of consignments }
 *   post:
 *     summary: Issue goods to a reseller on sale or return (multi-line)
 *     tags: [Consignments]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [business, party, lines]
 *             properties:
 *               business: { type: string }
 *               party:    { type: string, description: Reseller party id }
 *               lines:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [product, variantId, quantity, unitPrice]
 *                   properties:
 *                     product:   { type: string }
 *                     variantId: { type: string }
 *                     quantity:  { type: integer }
 *                     unitPrice: { type: number, description: Agreed price per unit (rupees) }
 *     responses:
 *       201: { description: Goods issued — Dr Goods-on-approval / Cr Inventory, no sale yet }
 *       400: { description: Not enough stock or invalid line }
 */
router
  .route('/')
  .get(
    can('consignments', 'read'),
    advancedResults(
      Consignment,
      { path: 'party', select: 'name' },
      ['consignmentNumber'],
      'consignmentNumber party status paymentStatus lineCount unitsRemaining createdAt'
    ),
    getConsignments
  )
  .post(
    can('consignments', 'create'),
    restrictBusinessToScope(),
    validate(consignmentCreateSchema),
    createConsignment
  );

/**
 * @swagger
 * /consignments/{id}/return:
 *   post:
 *     summary: Reseller returns some units of a line (back to stock, no sale)
 *     tags: [Consignments]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     requestBody:
 *       content: { application/json: { schema: { type: object, required: [lineId, quantity], properties: { lineId: { type: string }, quantity: { type: integer } } } } }
 *     responses:
 *       200: { description: Returned }
 */
router.post(
  '/:id/return',
  can('consignments', 'update'),
  loadScoped(Consignment),
  validate(consignmentReturnSchema),
  returnLine
);

/**
 * @swagger
 * /consignments/{id}/sell:
 *   post:
 *     summary: Reseller keeps/sells some units of a line (becomes a receivable + sale)
 *     tags: [Consignments]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     requestBody:
 *       content: { application/json: { schema: { type: object, required: [lineId, quantity], properties: { lineId: { type: string }, quantity: { type: integer }, unitPrice: { type: number } } } } }
 *     responses:
 *       200: { description: Sold }
 */
router.post(
  '/:id/sell',
  can('consignments', 'update'),
  loadScoped(Consignment),
  validate(consignmentSellSchema),
  sellLine
);

/**
 * @swagger
 * /consignments/{id}/payment:
 *   post:
 *     summary: Record a payment from the reseller for what he's kept
 *     tags: [Consignments]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     requestBody:
 *       content: { application/json: { schema: { type: object, properties: { amount: { type: number, description: Rupees; defaults to the full outstanding }, method: { type: string, enum: [cash, bank] } } } } }
 *     responses:
 *       200: { description: Payment recorded }
 */
router.post(
  '/:id/payment',
  can('consignments', 'update'),
  loadScoped(Consignment),
  validate(consignmentPaymentSchema),
  recordPayment
);

/**
 * @swagger
 * /consignments/{id}:
 *   get: { summary: Get a consignment, tags: [Consignments], security: [{ bearerAuth: [] }], responses: { 200: { description: Consignment } } }
 *   put: { summary: Edit an untouched consignment, tags: [Consignments], security: [{ bearerAuth: [] }], responses: { 200: { description: Updated } } }
 *   delete: { summary: Delete an untouched consignment, tags: [Consignments], security: [{ bearerAuth: [] }], responses: { 200: { description: Deleted } } }
 */
router
  .route('/:id')
  .get(can('consignments', 'read'), loadScoped(Consignment), getConsignment)
  .put(
    can('consignments', 'update'),
    loadScoped(Consignment),
    validate(consignmentUpdateSchema),
    updateConsignment
  )
  .delete(can('consignments', 'delete'), loadScoped(Consignment), deleteConsignment);

export default router;
