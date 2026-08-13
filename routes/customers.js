import express from 'express';
import { protect } from '../middlewares/auth.js';
import { can, loadScoped } from '../middlewares/permissions.js';
import advancedResults from '../middlewares/advancedResults.js';
import Customer from '../models/Customer.js';
import { getCustomers, getCustomer, updateCustomer } from '../controllers/customerController.js';

const router = express.Router();

router.use(protect);

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
  .get(can('customers', 'read'), advancedResults(Customer, null, ['name', 'phone']), getCustomers);

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
  .put(can('customers', 'update'), loadScoped(Customer), updateCustomer);

export default router;
