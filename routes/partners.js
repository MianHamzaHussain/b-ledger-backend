import express from 'express';
import { protect } from '../middlewares/auth.js';
import { can, loadScoped, restrictBusinessToScope } from '../middlewares/permissions.js';
import { validate } from '../middlewares/validate.js';
import {
  partnerCreateSchema,
  partnerUpdateSchema,
  distributeSchema,
  capitalMoveSchema
} from '../schemas/partners.js';
import advancedResults from '../middlewares/advancedResults.js';
import Partner from '../models/Partner.js';
import {
  getPartners,
  getPartner,
  createPartner,
  updatePartner,
  deletePartner,
  investPartner,
  withdrawPartner,
  distributeProfit
} from '../controllers/partnerController.js';

const router = express.Router();

router.use(protect);

/**
 * @swagger
 * tags:
 *   - name: Partners
 *     description: Owners/partners — equity, capital contributions, drawings, profit share
 */

/**
 * @swagger
 * /partners:
 *   get: { summary: List partners with capital balances, tags: [Partners], security: [{ bearerAuth: [] }], responses: { 200: { description: List } } }
 *   post:
 *     summary: Add a partner (creates their capital account)
 *     tags: [Partners]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content: { application/json: { schema: { type: object, required: [business, name], properties: { business: { type: string }, name: { type: string }, sharePercent: { type: number }, phone: { type: string }, note: { type: string } } } } }
 *     responses:
 *       201: { description: Partner created }
 */
router
  .route('/')
  .get(
    can('partners', 'read'),
    advancedResults(
      Partner,
      null,
      ['name'],
      'name sharePercent isActive capitalAccount business createdAt updatedAt'
    ),
    getPartners
  )
  .post(
    can('partners', 'create'),
    restrictBusinessToScope(),
    validate(partnerCreateSchema),
    createPartner
  );

/**
 * @swagger
 * /partners/distribute:
 *   post:
 *     summary: Distribute a profit amount to active partners by share %
 *     tags: [Partners]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content: { application/json: { schema: { type: object, required: [business, amount], properties: { business: { type: string }, amount: { type: number } } } } }
 *     responses:
 *       201: { description: Distributed }
 */
router.post(
  '/distribute',
  can('partners', 'update'),
  restrictBusinessToScope(),
  validate(distributeSchema),
  distributeProfit
);

/**
 * @swagger
 * /partners/{id}/invest:
 *   post: { summary: Partner puts capital in, tags: [Partners], security: [{ bearerAuth: [] }], responses: { 201: { description: Recorded } } }
 */
router.post(
  '/:id/invest',
  can('partners', 'update'),
  loadScoped(Partner),
  validate(capitalMoveSchema),
  investPartner
);

/**
 * @swagger
 * /partners/{id}/withdraw:
 *   post: { summary: Partner takes drawings out, tags: [Partners], security: [{ bearerAuth: [] }], responses: { 201: { description: Recorded } } }
 */
router.post(
  '/:id/withdraw',
  can('partners', 'update'),
  loadScoped(Partner),
  validate(capitalMoveSchema),
  withdrawPartner
);

/**
 * @swagger
 * /partners/{id}:
 *   get: { summary: Get a partner with statement, tags: [Partners], security: [{ bearerAuth: [] }], responses: { 200: { description: Partner } } }
 *   put: { summary: Edit a partner, tags: [Partners], security: [{ bearerAuth: [] }], responses: { 200: { description: Updated } } }
 *   delete: { summary: Delete a partner (only if no history), tags: [Partners], security: [{ bearerAuth: [] }], responses: { 200: { description: Deleted } } }
 */
router
  .route('/:id')
  .get(can('partners', 'read'), loadScoped(Partner), getPartner)
  .put(can('partners', 'update'), loadScoped(Partner), validate(partnerUpdateSchema), updatePartner)
  .delete(can('partners', 'delete'), loadScoped(Partner), deletePartner);

export default router;
