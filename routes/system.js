import express from 'express';
import { protect } from '../middlewares/auth.js';
import { requireAdmin } from '../middlewares/requireAdmin.js';
import { validate } from '../middlewares/validate.js';
import { ledgerClearSchema, resetSchema } from '../schemas/system.js';
import {
  getCities,
  ledgerClear,
  ledgerClearPreview,
  resetData,
  resetPreview
} from '../controllers/systemController.js';

const router = express.Router();

router.use(protect);

/**
 * @swagger
 * /system/cities:
 *   get:
 *     summary: The standard city list for the order form
 *     tags: [System]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: City names, alphabetically }
 */
router.get('/cities', getCities);

/**
 * @swagger
 * /system/reset-preview:
 *   get:
 *     summary: What clearing one business would delete (admin only)
 *     tags: [System]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: business, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Counts per kind, last order date, protection flag }
 *       403: { description: Not an admin }
 *       404: { description: No such business }
 */
router.get('/reset-preview', requireAdmin, resetPreview);

/**
 * @swagger
 * /system/reset:
 *   post:
 *     summary: Delete all records of one business (testing only)
 *     description: >
 *       Admin only, refused unless ALLOW_DATA_RESET=true, refused for a business marked
 *       protected, and only when the business's exact name is typed. Keeps the business, users,
 *       roles, categories and the order-number counter; writes a copy of the records first.
 *     tags: [System]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [business, confirmName]
 *             properties:
 *               business: { type: string }
 *               confirmName: { type: string }
 *     responses:
 *       200: { description: Records deleted; counts per kind }
 *       400: { description: Name does not match }
 *       403: { description: Not an admin, reset disabled, or business protected }
 *       404: { description: No such business }
 */
router.post('/reset', requireAdmin, validate(resetSchema), resetData);

/**
 * @swagger
 * /system/ledger-clear-preview:
 *   get:
 *     summary: What clearing the hand-entered money of one business would delete, and balances now → after
 *     tags: [System]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: business, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Entries by kind, period locks, and each money account's and khata person's balance }
 *       404: { description: Business not found }
 * /system/ledger-clear:
 *   post:
 *     summary: Delete the hand-entered money entries of ONE business, keeping orders, customer payments and connections
 *     description: >
 *       Admin only, and only when the server opts in with ALLOW_LEDGER_CLEAR=true. Works on a protected business.
 *       Deletes expenses, payments, transfers, capital, salaries, opening balances, manual entries and the period
 *       locks. Keeps orders, customer advances and refunds, courier invoices, PostEx receipts, the PostEx wallet
 *       (including its withdrawals) and customer payments. A copy of what is deleted is written first.
 *     tags: [System]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [business, confirmName]
 *             properties:
 *               business: { type: string }
 *               confirmName: { type: string }
 *     responses:
 *       200: { description: What was deleted and the balances that are left }
 *       400: { description: The typed name does not match }
 *       403: { description: Not an admin, or switched off on this server }
 */
router.get('/ledger-clear-preview', requireAdmin, ledgerClearPreview);
router.post('/ledger-clear', requireAdmin, validate(ledgerClearSchema), ledgerClear);

export default router;
