import express from 'express';
import { protect } from '../middlewares/auth.js';
import { can, loadScoped } from '../middlewares/permissions.js';
import advancedResults from '../middlewares/advancedResults.js';
import { validate } from '../middlewares/validate.js';
import Business from '../models/Business.js';
import { businessCreateSchema, businessUpdateSchema } from '../schemas/businesses.js';
import {
  getBusinesses,
  getBusiness,
  createBusiness,
  updateBusiness,
  deleteBusiness
} from '../controllers/businessController.js';

const router = express.Router();

router.use(protect);

/**
 * @swagger
 * /businesses:
 *   get:
 *     summary: Get all businesses
 *     tags: [Businesses]
 *     description: >
 *       Scoped. A user whose `businesses` permission has scope `own` sees only
 *       the businesses listed in their `assignedBusinesses`; scope `all` and
 *       admins see every business. Category is populated.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: search,   schema: { type: string } }
 *       - { in: query, name: category, schema: { type: string }, description: Category ObjectId }
 *       - { in: query, name: status,   schema: { type: string, enum: [active, inactive] } }
 *       - { in: query, name: page,     schema: { type: integer } }
 *       - { in: query, name: limit,    schema: { type: integer } }
 *     responses:
 *       200: { description: List of businesses }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *   post:
 *     summary: Create a business
 *     tags: [Businesses]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/Business' }
 *           example:
 *             name: Acme Clothing
 *             category: 60d0fe4f5311236168a109cc
 *             storeLink: https://acme-clothing.myshopify.com
 *             facebookLink: https://facebook.com/acmeclothing
 *             instagramLink: https://instagram.com/acmeclothing
 *             whatsappNumber: "+923001234567"
 *     responses:
 *       201: { description: Business created }
 *       400: { description: Validation error }
 */
router
  .route('/')
  .get(
    can('businesses', 'read'),
    // Lean list: name + category only (the card). Everything else — channels,
    // courier accounts, tax profile — comes from the detail-by-id endpoint.
    advancedResults(
      Business,
      { path: 'category', select: 'name status' },
      ['name', 'storeLink', 'whatsappNumber'],
      'name category status'
    ),
    getBusinesses
  )
  .post(can('businesses', 'create'), validate(businessCreateSchema), createBusiness);

/**
 * @swagger
 * /businesses/{id}:
 *   get:
 *     summary: Get single business
 *     tags: [Businesses]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Business }
 *       404: { description: Not found, or outside your assigned businesses }
 *   put:
 *     summary: Update a business
 *     tags: [Businesses]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Business updated }
 *       404: { description: Not found, or outside your assigned businesses }
 *   delete:
 *     summary: Delete a business
 *     tags: [Businesses]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Business deleted }
 */
router
  .route('/:id')
  .get(can('businesses', 'read'), loadScoped(Business), getBusiness)
  .put(
    can('businesses', 'update'),
    loadScoped(Business),
    validate(businessUpdateSchema),
    updateBusiness
  )
  .delete(can('businesses', 'delete'), loadScoped(Business), deleteBusiness);

export default router;
