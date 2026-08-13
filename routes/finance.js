import express from 'express';
import { protect } from '../middlewares/auth.js';
import { can, loadScoped, restrictBusinessToScope } from '../middlewares/permissions.js';
import { validate } from '../middlewares/validate.js';
import {
  capitalSchema,
  expenseSchema,
  paymentSchema,
  salarySchema,
  manualSchema,
  assetSchema,
  loanSchema,
  depreciationSchema,
  closeSchema
} from '../schemas/finance.js';
import JournalEntry from '../models/JournalEntry.js';
import {
  recordCapital,
  recordExpense,
  recordPayment,
  recordSalary,
  recordManual,
  recordAsset,
  recordLoan,
  recordDepreciation,
  closePeriod,
  getAccounts,
  getTrialBalance,
  getJournal,
  reverseJournalEntry,
  getProfitAndLoss,
  getBalanceSheet,
  getProductProfit,
  getPartyReport,
  getCourierRecon,
  getPeriodLock,
  lockPeriod,
  unlockPeriod
} from '../controllers/financeController.js';

const router = express.Router();

router.use(protect);

/**
 * @swagger
 * tags:
 *   - name: Finance
 *     description: Double-entry bookkeeping — capital, expenses, payments, salary, ledger
 */

/**
 * @swagger
 * /finance/capital:
 *   post:
 *     summary: Record owner investment or drawings
 *     tags: [Finance]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [business, amount, direction]
 *             properties:
 *               business:  { type: string }
 *               amount:    { type: number, description: "Rupees" }
 *               direction: { type: string, enum: [invest, drawings] }
 *               method:    { type: string, enum: [cash, bank] }
 *               date:      { type: string, format: date }
 *               memo:      { type: string }
 *           example:
 *             business: "66a1f2c3b4d5e6f708091001"
 *             amount: 200000
 *             direction: invest
 *             method: cash
 *     responses:
 *       201:
 *         description: Journal entry posted (Dr Cash / Cr Owner's Capital)
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data:
 *                 _id: "66b1f2c3b4d5e6f708091020"
 *                 business: "66a1f2c3b4d5e6f708091001"
 *                 date: "2026-08-06T10:00:00.000Z"
 *                 memo: Owner investment
 *                 source: { kind: capital }
 *                 lines:
 *                   - { account: "66a0000000000000000001000", debitPaisa: 20000000 }
 *                   - { account: "66a0000000000000000003000", creditPaisa: 20000000 }
 *       400: { description: Amount must be greater than zero }
 *       403: { description: Not assigned to that business }
 */
router.post(
  '/capital',
  can('journal', 'create'),
  restrictBusinessToScope(),
  validate(capitalSchema),
  recordCapital
);

/**
 * @swagger
 * /finance/expenses:
 *   post:
 *     summary: Record an expense (paid, or on credit to a supplier)
 *     tags: [Finance]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [business, amount]
 *             properties:
 *               business: { type: string }
 *               amount:   { type: number }
 *               category: { type: string, description: "Expense account code (e.g. 5100). Defaults to Miscellaneous." }
 *               party:    { type: string, description: "Supplier — required when onCredit" }
 *               product:  { type: string }
 *               onCredit: { type: boolean }
 *               method:   { type: string, enum: [cash, bank] }
 *           example:
 *             business: "66a1f2c3b4d5e6f708091001"
 *             amount: 5000
 *             category: "5100"
 *             onCredit: true
 *             party: "66a1f2c3b4d5e6f708091012"
 *     responses:
 *       201:
 *         description: Entry posted (Dr Expense / Cr Cash or Accounts Payable)
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data:
 *                 _id: "66b1f2c3b4d5e6f708091021"
 *                 business: "66a1f2c3b4d5e6f708091001"
 *                 memo: Raw Material
 *                 source: { kind: expense }
 *                 lines:
 *                   - { account: "66a0000000000000000005100", debitPaisa: 500000 }
 *                   - { account: "66a0000000000000000002000", party: "66a1f2c3b4d5e6f708091012", creditPaisa: 500000 }
 *       400: { description: Not an expense account, or supplier missing on credit }
 */
router.post(
  '/expenses',
  can('journal', 'create'),
  restrictBusinessToScope(),
  validate(expenseSchema),
  recordExpense
);

/**
 * @swagger
 * /finance/payments:
 *   post:
 *     summary: Pay a supplier down, or collect from a reseller
 *     tags: [Finance]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [business, party, amount, direction]
 *             properties:
 *               business:  { type: string }
 *               party:     { type: string }
 *               amount:    { type: number }
 *               direction: { type: string, enum: [pay, receive] }
 *               method:    { type: string, enum: [cash, bank] }
 *           example:
 *             business: "66a1f2c3b4d5e6f708091001"
 *             party: "66a1f2c3b4d5e6f708091012"
 *             amount: 16000
 *             direction: pay
 *             method: cash
 *     responses:
 *       201:
 *         description: Entry posted. `pay` → Dr Payable / Cr Cash; `receive` → Dr Cash / Cr Receivable
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data:
 *                 _id: "66b1f2c3b4d5e6f708091022"
 *                 source: { kind: payment }
 *                 lines:
 *                   - { account: "66a0000000000000000002000", party: "66a1f2c3b4d5e6f708091012", debitPaisa: 1600000 }
 *                   - { account: "66a0000000000000000001000", creditPaisa: 1600000 }
 *       400: { description: Party missing }
 */
router.post(
  '/payments',
  can('journal', 'create'),
  restrictBusinessToScope(),
  validate(paymentSchema),
  recordPayment
);

/**
 * @swagger
 * /finance/salary:
 *   post:
 *     summary: Record salary (paid, or accrued as owed)
 *     tags: [Finance]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [business, amount]
 *             properties:
 *               business: { type: string }
 *               amount:   { type: number, description: Rupees }
 *               party:    { type: string, description: "Employee — required when onCredit (accrue)" }
 *               onCredit: { type: boolean, description: "true = accrue (Cr Salaries Payable); false = paid (Cr Cash/Bank)" }
 *               method:   { type: string, enum: [cash, bank] }
 *           example:
 *             business: "66a1f2c3b4d5e6f708091001"
 *             amount: 15000
 *             method: cash
 *     responses:
 *       201:
 *         description: Entry posted (Dr Salaries / Cr Cash-Bank or Salaries Payable)
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data:
 *                 _id: "66b1f2c3b4d5e6f708091023"
 *                 source: { kind: salary }
 *                 lines:
 *                   - { account: "66a0000000000000000005300", debitPaisa: 1500000 }
 *                   - { account: "66a0000000000000000001000", creditPaisa: 1500000 }
 */
router.post(
  '/salary',
  can('journal', 'create'),
  restrictBusinessToScope(),
  validate(salarySchema),
  recordSalary
);

/**
 * @swagger
 * /finance/manual:
 *   post:
 *     summary: Record a general (manual) Dr/Cr entry
 *     tags: [Finance]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content: { application/json: { schema: { type: object, required: [business, debitAccount, creditAccount, amount], properties: { business: { type: string }, debitAccount: { type: string, description: Account code to debit }, creditAccount: { type: string, description: Account code to credit }, amount: { type: number }, memo: { type: string } } } } }
 *     responses:
 *       201: { description: Entry posted }
 */
router.post(
  '/manual',
  can('journal', 'create'),
  restrictBusinessToScope(),
  validate(manualSchema),
  recordManual
);

/**
 * @swagger
 * /finance/assets:
 *   post: { summary: Buy a fixed asset (cash/bank or on credit), tags: [Finance], security: [{ bearerAuth: [] }], responses: { 201: { description: Posted } } }
 */
router.post(
  '/assets',
  can('journal', 'create'),
  restrictBusinessToScope(),
  validate(assetSchema),
  recordAsset
);

/**
 * @swagger
 * /finance/loans:
 *   post: { summary: Take or repay a loan (repay expenses optional interest), tags: [Finance], security: [{ bearerAuth: [] }], responses: { 201: { description: Posted } } }
 */
router.post(
  '/loans',
  can('journal', 'create'),
  restrictBusinessToScope(),
  validate(loanSchema),
  recordLoan
);

/**
 * @swagger
 * /finance/depreciation:
 *   post: { summary: Record depreciation on fixed assets, tags: [Finance], security: [{ bearerAuth: [] }], responses: { 201: { description: Posted } } }
 */
router.post(
  '/depreciation',
  can('journal', 'create'),
  restrictBusinessToScope(),
  validate(depreciationSchema),
  recordDepreciation
);

/**
 * @swagger
 * /finance/close:
 *   post:
 *     summary: Year-end close — sweep income/expense into retained earnings
 *     tags: [Finance]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content: { application/json: { schema: { type: object, required: [business], properties: { business: { type: string }, date: { type: string, format: date }, memo: { type: string } } } } }
 *     responses:
 *       201: { description: Closed; returns the net profit moved to equity }
 *       400: { description: Nothing to close }
 */
router.post(
  '/close',
  can('journal', 'create'),
  restrictBusinessToScope(),
  validate(closeSchema),
  closePeriod
);

/**
 * @swagger
 * /finance/accounts:
 *   get:
 *     summary: The chart of accounts for a business (seeded on first read)
 *     tags: [Finance]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: query, name: business, required: true, schema: { type: string } }]
 *     responses:
 *       200:
 *         description: Chart of accounts (23 seeded accounts)
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               count: 23
 *               data:
 *                 - { code: "1000", name: Cash, type: asset, normalBalance: debit, isControl: false }
 *                 - { code: "2000", name: Accounts Payable, type: liability, normalBalance: credit, isControl: true }
 *                 - { code: "4000", name: Sales, type: income, normalBalance: credit }
 */
router.get('/accounts', can('accounts', 'read'), getAccounts);

/**
 * @swagger
 * /finance/trial-balance:
 *   get:
 *     summary: Trial balance — every account's net (must sum to zero)
 *     tags: [Finance]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: business, required: true, schema: { type: string } }
 *       - { in: query, name: from, schema: { type: string, format: date } }
 *       - { in: query, name: to, schema: { type: string, format: date } }
 *     responses:
 *       200:
 *         description: Every account's net; `totalPaisa` must be 0 and `balanced` true
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data:
 *                 rows:
 *                   - { code: "1000", name: Cash, type: asset, netPaisa: 16580000 }
 *                   - { code: "2000", name: Accounts Payable, type: liability, netPaisa: -1000000 }
 *                 totalPaisa: 0
 *                 balanced: true
 */
router.get('/trial-balance', can('reports', 'read'), getTrialBalance);

/**
 * @swagger
 * /finance/journal:
 *   get:
 *     summary: The journal — every posted entry, newest first, with its lines
 *     description: >
 *       Posted entries are immutable (append-only history). A mistake is fixed
 *       with the /reverse action below, never by editing. Each row carries
 *       `isReversal` (it undoes another) and `reversed` (it has been undone).
 *     tags: [Finance]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: business, required: true, schema: { type: string } }
 *       - { in: query, name: page, schema: { type: integer, default: 1 } }
 *       - { in: query, name: limit, schema: { type: integer, default: 25 } }
 *     responses:
 *       200:
 *         description: A page of journal entries
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               count: 1
 *               total: 1
 *               pagination: {}
 *               data:
 *                 - _id: "66f...01"
 *                   date: "2026-08-03T00:00:00.000Z"
 *                   memo: Owner investment
 *                   source: { kind: capital }
 *                   isReversal: false
 *                   reversed: false
 *                   lines:
 *                     - { account: { code: "1000", name: Cash, type: asset }, debitPaisa: 10000000, creditPaisa: 0 }
 *                     - { account: { code: "3000", name: Owner's Capital, type: equity }, debitPaisa: 0, creditPaisa: 10000000 }
 */
router.get('/journal', can('journal', 'read'), getJournal);

/**
 * @swagger
 * /finance/journal/{id}/reverse:
 *   post:
 *     summary: Reverse a posted entry (audit-safe undo — posts a mirror entry)
 *     description: >
 *       Posts a mirror of the entry dated today, so the pair nets to zero. Fails
 *       if the entry is itself a reversal, or has already been reversed. This is
 *       the correct way to undo — editing a posted entry is intentionally not
 *       possible.
 *     tags: [Finance]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema: { type: object, properties: { memo: { type: string } } }
 *     responses:
 *       201:
 *         description: Reversal entry posted
 *         content:
 *           application/json:
 *             example: { success: true, data: { _id: "66f...02", reversalOf: "66f...01", memo: "Reversal of entry 66f...01" } }
 *       400: { description: Already reversed, or the entry is itself a reversal }
 *       404: { description: Not found or out of scope }
 */
router.post(
  '/journal/:id/reverse',
  can('journal', 'update'),
  loadScoped(JournalEntry),
  reverseJournalEntry
);

/**
 * @swagger
 * /finance/reports/pnl:
 *   get:
 *     summary: Profit & Loss for a period (amounts in paisa)
 *     tags: [Finance]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: business, required: true, schema: { type: string } }
 *       - { in: query, name: from, schema: { type: string, format: date } }
 *       - { in: query, name: to, schema: { type: string, format: date } }
 *     responses:
 *       200:
 *         description: Income, expense and net profit
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data:
 *                 income:
 *                   - { code: "4000", name: Sales, type: income, amountPaisa: 1880000 }
 *                 expense:
 *                   - { code: "5000", name: Cost of Goods Sold, type: expense, amountPaisa: 1200000 }
 *                   - { code: "5200", name: Delivery Charges, type: expense, amountPaisa: 50000 }
 *                   - { code: "5300", name: Salaries, type: expense, amountPaisa: 1500000 }
 *                   - { code: "5400", name: Rent, type: expense, amountPaisa: 800000 }
 *                 incomePaisa: 1880000
 *                 expensePaisa: 3550000
 *                 netProfitPaisa: -1670000
 *       403: { description: Missing reports:read permission }
 */
router.get('/reports/pnl', can('reports', 'read'), getProfitAndLoss);

/**
 * @swagger
 * /finance/reports/balance-sheet:
 *   get:
 *     summary: Balance sheet as of a date — Assets = Liabilities + Equity (paisa)
 *     tags: [Finance]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: business, required: true, schema: { type: string } }
 *       - { in: query, name: asOf, schema: { type: string, format: date } }
 *     responses:
 *       200:
 *         description: Grouped accounts and totals; `balanced` must be true
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data:
 *                 assets:
 *                   - { code: "1000", name: Cash, amountPaisa: 16580000 }
 *                   - { code: "1010", name: Bank, amountPaisa: 950000 }
 *                   - { code: "1300", name: Inventory, amountPaisa: 1800000 }
 *                 liabilities:
 *                   - { code: "2000", name: Accounts Payable, amountPaisa: 1000000 }
 *                 equity:
 *                   - { code: "3000", name: Owner Capital, amountPaisa: 20000000 }
 *                 retainedPaisa: -1670000
 *                 assetsPaisa: 19330000
 *                 liabilitiesPaisa: 1000000
 *                 totalEquityPaisa: 18330000
 *                 balanced: true
 */
router.get('/reports/balance-sheet', can('reports', 'read'), getBalanceSheet);

/**
 * @swagger
 * /finance/reports/product-profit:
 *   get:
 *     summary: Profit per product from delivered orders (rupees)
 *     tags: [Finance]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: business, required: true, schema: { type: string } }
 *       - { in: query, name: from, schema: { type: string, format: date } }
 *       - { in: query, name: to, schema: { type: string, format: date } }
 *     responses:
 *       200:
 *         description: One row per product, sorted by profit
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data:
 *                 - { product: "66a1f2c3b4d5e6f708091011", name: Lawn Suit, quantity: 4, revenue: 10000, cost: 6000, profit: 4000 }
 */
router.get('/reports/product-profit', can('reports', 'read'), getProductProfit);

/**
 * @swagger
 * /finance/reports/parties:
 *   get:
 *     summary: Receivables & payables by party (paisa)
 *     tags: [Finance]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: query, name: business, required: true, schema: { type: string } }]
 *     responses:
 *       200:
 *         description: Who owes you (receivables) and who you owe (payables)
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data:
 *                 receivables: []
 *                 payables:
 *                   - { party: "66a1f2c3b4d5e6f708091012", name: Master Tailor, type: supplier, balancePaisa: 1000000 }
 *                 receivablePaisa: 0
 *                 payablePaisa: 1000000
 */
router.get('/reports/parties', can('reports', 'read'), getPartyReport);

/**
 * @swagger
 * /finance/reports/courier:
 *   get:
 *     summary: COD still held by each courier — expected vs remitted (paisa)
 *     tags: [Finance]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: query, name: business, required: true, schema: { type: string } }]
 *     responses:
 *       200:
 *         description: Outstanding COD per courier
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data:
 *                 rows:
 *                   - { courier: "66a1f2c3b4d5e6f708091013", name: TCS, outstandingPaisa: 220000 }
 *                 outstandingPaisa: 220000
 */
router.get('/reports/courier', can('reports', 'read'), getCourierRecon);

/**
 * @swagger
 * /finance/period-lock:
 *   get:
 *     summary: The date the books are locked through (null if unlocked)
 *     tags: [Finance]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: query, name: business, required: true, schema: { type: string } }]
 *     responses:
 *       200:
 *         description: Current lock
 *         content:
 *           application/json:
 *             example: { success: true, data: { periodEnd: "2026-07-31T23:59:59.000Z" } }
 *   post:
 *     summary: Lock the books through a date (freezes those entries)
 *     tags: [Finance]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [business, periodEnd]
 *             properties:
 *               business:  { type: string }
 *               periodEnd: { type: string, format: date-time }
 *           example: { business: "66a1f2c3b4d5e6f708091001", periodEnd: "2026-07-31T23:59:59.000Z" }
 *     responses:
 *       201:
 *         description: Locked
 *         content:
 *           application/json:
 *             example: { success: true, data: { periodEnd: "2026-07-31T23:59:59.000Z" } }
 *   delete:
 *     summary: Unlock the most recent period
 *     tags: [Finance]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: query, name: business, required: true, schema: { type: string } }]
 *     responses:
 *       200:
 *         description: Unlocked (returns the next remaining lock, or null)
 *         content:
 *           application/json:
 *             example: { success: true, data: { periodEnd: null } }
 */
router
  .route('/period-lock')
  .get(can('journal', 'read'), getPeriodLock)
  .post(can('journal', 'update'), restrictBusinessToScope(), lockPeriod)
  .delete(can('journal', 'delete'), unlockPeriod);

export default router;
