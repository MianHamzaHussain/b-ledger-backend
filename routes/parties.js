import express from 'express';
import { protect } from '../middlewares/auth.js';
import { can, loadScoped, restrictBusinessToScope } from '../middlewares/permissions.js';
import advancedResults from '../middlewares/advancedResults.js';
import Party from '../models/Party.js';
import {
  getParties,
  getParty,
  createParty,
  updateParty,
  deleteParty,
  getPartyStatement
} from '../controllers/partyController.js';

const router = express.Router();

router.use(protect);

/**
 * @swagger
 * /parties:
 *   get:
 *     summary: List parties (suppliers, resellers, employees, couriers) with balances
 *     tags: [Finance]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: business, schema: { type: string } }
 *       - { in: query, name: type, schema: { type: string, enum: [supplier, reseller, employee, courier] } }
 *       - { in: query, name: search, schema: { type: string } }
 *     responses:
 *       200:
 *         description: List of parties, each with a derived balance (rupees; + they owe you, − you owe them)
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               count: 2
 *               total: 2
 *               data:
 *                 - { _id: "66a...12", name: Master Tailor, type: supplier, balance: -10000, isActive: true }
 *                 - { _id: "66a...13", name: Bilal Store, type: reseller, balance: 8800, isActive: true }
 *   post:
 *     summary: Create a party
 *     tags: [Finance]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Party created }
 */
router
  .route('/')
  .get(can('parties', 'read'), advancedResults(Party, null, ['name', 'phone']), getParties)
  .post(can('parties', 'create'), restrictBusinessToScope(), createParty);

/**
 * @swagger
 * /parties/{id}/statement:
 *   get:
 *     summary: A party's ledger statement with running balance
 *     tags: [Finance]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses:
 *       200:
 *         description: Every ledger line touching the party, with a running balance (rupees)
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data:
 *                 party: { _id: "66a...12", name: Master Tailor, type: supplier }
 *                 balance: -10000
 *                 rows:
 *                   - { date: "2026-08-03T09:00:00.000Z", memo: Tailoring, debit: 0, credit: 10000, balance: -10000 }
 *       404: { description: Not found or out of scope }
 */
router.get('/:id/statement', can('parties', 'read'), loadScoped(Party), getPartyStatement);

/**
 * @swagger
 * /parties/{id}:
 *   get: { summary: Get a party, tags: [Finance], security: [{ bearerAuth: [] }], responses: { 200: { description: Party } } }
 *   put: { summary: Update a party, tags: [Finance], security: [{ bearerAuth: [] }], responses: { 200: { description: Updated } } }
 *   delete: { summary: Delete a party (blocked if it has ledger history), tags: [Finance], security: [{ bearerAuth: [] }], responses: { 200: { description: Deleted }, 400: { description: Has ledger history } } }
 */
router
  .route('/:id')
  .get(can('parties', 'read'), loadScoped(Party), getParty)
  .put(can('parties', 'update'), loadScoped(Party), updateParty)
  .delete(can('parties', 'delete'), loadScoped(Party), deleteParty);

export default router;
