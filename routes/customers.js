import express from 'express';
import { protect } from '../middlewares/auth.js';
import rateLimit from 'express-rate-limit';
import { can, loadScoped, restrictBusinessToScope } from '../middlewares/permissions.js';
import advancedResults from '../middlewares/advancedResults.js';
import { validate } from '../middlewares/validate.js';
import Customer from '../models/Customer.js';
import {
  customerCreateSchema,
  customerImportSchema,
  customerUpdateSchema
} from '../schemas/customers.js';
import {
  getCustomers,
  getCustomer,
  createCustomer,
  importCustomers,
  exportCustomers,
  updateCustomer
} from '../controllers/customerController.js';

const router = express.Router();

router.use(protect);

/** An export is the whole contact list leaving the app: a few an hour is plenty for a person. */
const exportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  keyGenerator: req => String(req.user?.id ?? 'anonymous'),
  message: { success: false, error: 'Too many exports. Please try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false }
});

/**
 * @swagger
 * /customers:
 *   get:
 *     summary: Get all customers (created via orders)
 *     tags: [Customers]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: search, schema: { type: string }, description: name or phone }
 *       - { in: query, name: page,   schema: { type: integer } }
 *       - { in: query, name: limit,  schema: { type: integer } }
 *     responses:
 *       200: { description: List of customers }
 */
router
  .route('/')
  .get(can('customers', 'read'), advancedResults(Customer, null, ['name', 'phone']), getCustomers)
  .post(
    can('customers', 'create'),
    restrictBusinessToScope(),
    validate(customerCreateSchema),
    createCustomer
  );

/**
 * @swagger
 * /customers/import:
 *   post:
 *     summary: Import a list of contacts (up to 500 rows a request; existing phones are skipped)
 *     tags: [Customers]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [business, rows]
 *             properties:
 *               business: { type: string }
 *               rows:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     name: { type: string }
 *                     phone: { type: string }
 *                     city: { type: string }
 *                     note: { type: string }
 *     responses:
 *       200: { description: "{ added, skipped, invalid: [{ row, reason }] }" }
 *       403: { description: Not assigned to that business }
 */
// Literal paths before /:id so they are not swallowed as an id.
router.post(
  '/import',
  can('customers', 'create'),
  restrictBusinessToScope(),
  validate(customerImportSchema),
  importCustomers
);

/**
 * @swagger
 * /customers/export:
 *   get:
 *     summary: One business's customers as a CSV (name, phone, whatsapp, city, source, addedOn)
 *     tags: [Customers]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: business, required: true, schema: { type: string } }
 *       - { in: query, name: search, schema: { type: string } }
 *     responses:
 *       200: { description: A CSV file }
 *       404: { description: Outside your assigned businesses }
 *       429: { description: Too many exports }
 */
router.get('/export', can('customers', 'read'), exportLimiter, exportCustomers);

/**
 * @swagger
 * /customers/{id}:
 *   get:
 *     summary: Get single customer
 *     tags: [Customers]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: Customer }
 *   put:
 *     summary: Correct a customer's name / city
 *     tags: [Customers]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: Updated }
 */
router
  .route('/:id')
  .get(can('customers', 'read'), loadScoped(Customer), getCustomer)
  .put(
    can('customers', 'update'),
    loadScoped(Customer),
    validate(customerUpdateSchema),
    updateCustomer
  );

export default router;
