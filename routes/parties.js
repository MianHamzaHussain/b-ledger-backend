import express from 'express';
import { protect } from '../middlewares/auth.js';
import { can, loadScoped, restrictBusinessToScope } from '../middlewares/permissions.js';
import advancedResults from '../middlewares/advancedResults.js';
import { validate } from '../middlewares/validate.js';
import Party from '../models/Party.js';
import {
  partyCreateSchema,
  partyUpdateSchema,
  partyTransactionSchema,
  partyOpeningSchema,
  courierInvoiceSchema,
  courierConnectionSchema
} from '../schemas/parties.js';
import { getCourierItems, createCourierInvoice } from '../controllers/courierInvoiceController.js';
import { requireAdmin } from '../middlewares/requireAdmin.js';
import { lookupParties } from '../controllers/partyLookupController.js';
import {
  getConnection,
  saveConnection,
  testConnection,
  removeConnection
} from '../controllers/courierConnectionController.js';
import {
  getParties,
  getParty,
  createParty,
  updateParty,
  deleteParty,
  getPartyStatement,
  getPartySummary,
  recordPartyTransaction,
  recordPartyOpeningBalance,
  reversePartyEntry
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
  .post(
    can('parties', 'create'),
    restrictBusinessToScope(),
    validate(partyCreateSchema),
    createParty
  );

/**
 * @swagger
 * /parties/summary:
 *   get:
 *     summary: Totals owed to you and owed by you, across every party of a business
 *     tags: [Finance]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: query, name: business, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: "{ receivable, payable } in rupees (and paisa)" }
 *       404: { description: Business outside your scope }
 */
router.get('/summary', can('parties', 'read'), getPartySummary);

/**
 * @swagger
 * /parties/lookup:
 *   get:
 *     summary: Pick a party for a task (name, phone, account id — never a balance)
 *     description: >
 *       For whoever needs the person for their own work — a dispatcher picking a courier — without
 *       Khata access. Allowed with the permission for that task, or parties:read.
 *     tags: [Finance]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: business, required: true, schema: { type: string } }
 *       - { in: query, name: type, required: true, schema: { type: string, enum: [supplier, reseller, employee, courier, customer, lender] } }
 *       - { in: query, name: search, schema: { type: string } }
 *       - { in: query, name: limit, schema: { type: integer, maximum: 20 } }
 *       - { in: query, name: page, schema: { type: integer } }
 *     responses:
 *       200: { description: "[{ _id, name, type, phone, accountId, booksWithService? }] and pagination.next while more remain" }
 *       403: { description: Not allowed to find this kind of party }
 *       404: { description: Business outside your scope }
 */
router.get('/lookup', lookupParties);

/**
 * @swagger
 * /parties/{id}/transactions:
 *   post:
 *     summary: '"You gave" / "You got" on a party — posted to the right account for its type'
 *     description: >
 *       supplier: gave = payment, got = a bill (needs `category`, an expense code).
 *       reseller/customer: gave = money given, got = payment received (a customer's
 *       payment is applied to their unpaid counter sales, oldest first).
 *       employee: gave = salary paid (clears owed salary first), got = salary due.
 *       lender: gave = principal repaid (at most what is owed), got = loan taken.
 *       courier: refused — its money is recorded on its invoice (courier-invoices).
 *     tags: [Finance]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [direction, amount]
 *             properties:
 *               direction: { type: string, enum: [gave, got] }
 *               amount:    { type: number, description: Rupees }
 *               method:    { type: string, enum: [cash, bank] }
 *               category:  { type: string, description: "Expense account code — a supplier's bill" }
 *               date:      { type: string, format: date }
 *               memo:      { type: string }
 *     responses:
 *       201: { description: Entry posted }
 *       400: { description: Invalid for this party type (e.g. courier, bill with no category) }
 *       404: { description: Party not found or outside your businesses }
 */
/**
 * @swagger
 * /parties/{id}/opening:
 *   post:
 *     summary: A person's balance from before starting on B Ledger (no cash, no profit)
 *     tags: [Parties]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Opening balance posted }
 */
router.post(
  '/:id/opening',
  can('journal', 'create'),
  loadScoped(Party),
  validate(partyOpeningSchema),
  recordPartyOpeningBalance
);

/**
 * @swagger
 * /parties/{id}/entries/{entryId}/reverse:
 *   post:
 *     summary: Reverse one of this person's Khata entries (payment, bill, salary, loan, opening)
 *     description: The entry stays in the history with a matching reversal. Order, courier-invoice, material and batch entries are undone where they were made.
 *     tags: [Parties]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Reversal posted }
 *       400: { description: Not reversible here, or already reversed }
 *       404: { description: Entry is not on this person }
 */
router.post(
  '/:id/entries/:entryId/reverse',
  can('journal', 'create'),
  loadScoped(Party),
  reversePartyEntry
);

router.post(
  '/:id/transactions',
  can('journal', 'create'),
  loadScoped(Party),
  validate(partyTransactionSchema),
  recordPartyTransaction,
  recordPartyOpeningBalance
);

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
 * /parties/{id}/connection:
 *   get:
 *     summary: A courier's connection to its service (admin only; never returns the key)
 *     tags: [Parties]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: "{ provider, isEnabled, hasToken, pickupAddressCode, lastCheckedAt, lastError }" }
 *       403: { description: Not an admin }
 *   put:
 *     summary: Save the courier key (write-only), pickup address, or switch booking on or off
 *     tags: [Parties]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: The connection, without the key }
 *       503: { description: COURIER_SECRET_KEY is not set on this server }
 *   delete:
 *     summary: Disconnect the courier and forget its key
 *     tags: [Parties]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Disconnected }
 */
router
  .route('/:id/connection')
  .get(can('parties', 'read'), requireAdmin, loadScoped(Party), getConnection)
  .put(
    can('parties', 'update'),
    requireAdmin,
    loadScoped(Party),
    validate(courierConnectionSchema),
    saveConnection
  )
  .delete(can('parties', 'update'), requireAdmin, loadScoped(Party), removeConnection);

/**
 * @swagger
 * /parties/{id}/connection/test:
 *   post:
 *     summary: Check the saved key by asking the courier for its pickup addresses
 *     tags: [Parties]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ addresses: [{ addressCode, address, cityName }] }" }
 *       502: { description: The courier refused the key or could not be reached }
 */
router.post(
  '/:id/connection/test',
  can('parties', 'update'),
  requireAdmin,
  loadScoped(Party),
  testConnection
);

/**
 * @swagger
 * /parties/{id}/courier-items:
 *   get:
 *     summary: A courier's open parcels — unpaid CODs and charges not billed yet
 *     tags: [Finance]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: "{ defaultMoneyAccount, items: [{ order, orderNumber, trackingId, customerName, status, cod: { cod, withholdingTax, salesTax, net } | null, deliveryChargeOpen, returnChargeOpen }] }" }
 *       400: { description: Not a courier }
 */
router.get('/:id/courier-items', can('journal', 'read'), loadScoped(Party), getCourierItems);

/**
 * @swagger
 * /parties/{id}/courier-invoices:
 *   post:
 *     summary: Record a courier invoice — CODs paid, charges billed per parcel, and what arrived
 *     description: >
 *       COD and charges settle independently, so one invoice may pay some parcels'
 *       COD and bill other parcels' charges. Ticked CODs are marked paid and billed
 *       charges set on their orders; reversing the entry undoes both. The same
 *       invoice number can't be recorded twice for a courier.
 *     tags: [Finance]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: []
 *             properties:
 *               invoiceNumber: { type: string, description: "Optional — some invoices carry none" }
 *               invoiceDate: { type: string }
 *               received: { type: number, description: "What arrived; 0 if the courier only deducted charges" }
 *               account: { type: string, description: "Money account id or partner:<id> it arrived in" }
 *               cod: { type: array, items: { type: string }, description: Order ids whose COD this pays }
 *               charges: { type: array, items: { type: object, properties: { order: { type: string }, kind: { type: string, enum: [delivery, return] }, amount: { type: number } } } }
 *     responses:
 *       201: { description: "Recorded — { expected, received, difference, codCount, chargeCount }" }
 *       400: { description: Duplicate invoice number, nothing ticked, or a parcel not open with this courier }
 */
router.post(
  '/:id/courier-invoices',
  can('journal', 'create'),
  loadScoped(Party),
  validate(courierInvoiceSchema),
  createCourierInvoice
);

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
  .put(can('parties', 'update'), loadScoped(Party), validate(partyUpdateSchema), updateParty)
  .delete(can('parties', 'delete'), loadScoped(Party), deleteParty);

export default router;
