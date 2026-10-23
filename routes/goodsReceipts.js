import express from 'express';
import { protect } from '../middlewares/auth.js';
import { can, loadScoped, restrictBusinessToScope, hideCosts } from '../middlewares/permissions.js';
import { validate } from '../middlewares/validate.js';
import advancedResults from '../middlewares/advancedResults.js';
import GoodsReceipt from '../models/GoodsReceipt.js';
import {
  goodsReceiptCreateSchema,
  goodsReceiptNoteSchema,
  goodsReceiptReturnSchema
} from '../schemas/goodsReceipts.js';
import {
  getGoodsReceipts,
  getGoodsReceipt,
  createGoodsReceipt,
  updateGoodsReceiptNote,
  returnGoods,
  undoGoodsReceipt
} from '../controllers/goodsReceiptController.js';

const router = express.Router();

router.use(protect);
// What a delivery cost is a cost: quantities show, money doesn't, without "See costs".
router.use(hideCosts);

/**
 * @swagger
 * tags:
 *   - name: Goods received
 *     description: Finished goods bought from a supplier — stock in, what is owed, and what goes back
 */

/**
 * @swagger
 * /goods-receipts:
 *   get:
 *     summary: List supplier deliveries
 *     tags: [Goods received]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: business, schema: { type: string } }
 *       - { in: query, name: party, schema: { type: string } }
 *     responses:
 *       200: { description: Lean list — number, date, supplier, total, status }
 *   post:
 *     summary: Record a delivery (stock in; the supplier is owed, or paid now)
 *     description: >
 *       Each line is an article we already stock (product, variantId, quantity,
 *       unitCost) or a new one (newProduct with its sizes), which is created with an
 *       article number. Dr Inventory / Cr Payables [supplier]; if paid now, also
 *       Dr Payables / Cr the money account.
 *     tags: [Goods received]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: The receipt, with its lines' stock }
 *       400: { description: Bad line, not a supplier, or paid now more than the total }
 */
router
  .route('/')
  .get(
    can('goodsReceipts', 'read'),
    advancedResults(
      GoodsReceipt,
      { path: 'party', select: 'name' },
      ['receiptNumber'],
      'receiptNumber party date totalCostPaisa paidNowPaisa lineCount status createdAt business'
    ),
    getGoodsReceipts
  )
  .post(
    can('goodsReceipts', 'create'),
    restrictBusinessToScope(),
    validate(goodsReceiptCreateSchema),
    createGoodsReceipt
  );

/**
 * @swagger
 * /goods-receipts/{id}:
 *   get:
 *     summary: One delivery, with what is still in stock and what can go back
 *     tags: [Goods received]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: The receipt }
 *       404: { description: Not found, or outside your businesses }
 */
router
  .route('/:id')
  .get(can('goodsReceipts', 'read'), loadScoped(GoodsReceipt), getGoodsReceipt)
  /**
   * @swagger
   * /goods-receipts/{id}:
   *   patch:
   *     summary: Change the note on a delivery
   *     description: >
   *       Only the note. Items, cost and what was paid are fixed once recorded — undo
   *       the delivery and enter it again to fix those. An empty note clears it.
   *     tags: [Goods received]
   *     security: [{ bearerAuth: [] }]
   *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
   *     responses:
   *       200: { description: The receipt with its new note }
   *       400: { description: Note longer than 200 characters }
   *       404: { description: Not found, or outside your businesses }
   */
  .patch(
    can('goodsReceipts', 'update'),
    loadScoped(GoodsReceipt),
    validate(goodsReceiptNoteSchema),
    updateGoodsReceiptNote
  );

/**
 * @swagger
 * /goods-receipts/{id}/returns:
 *   post:
 *     summary: Send pieces back to the supplier
 *     description: >
 *       Credited at what the supplier billed for each line. Only what is still on
 *       the shelf can go back. Dr Payables [supplier] / Cr Inventory.
 *     tags: [Goods received]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses:
 *       201: { description: The receipt, with the send-back added }
 *       400: { description: More than is left to send back }
 */
router.post(
  '/:id/returns',
  can('goodsReceipts', 'update'),
  loadScoped(GoodsReceipt),
  validate(goodsReceiptReturnSchema),
  returnGoods
);

/**
 * @swagger
 * /goods-receipts/{id}/undo:
 *   post:
 *     summary: Undo a delivery that nothing has happened to
 *     description: >
 *       Only when nothing was sent back and every size still holds what arrived.
 *       An article the delivery created stays, at zero stock.
 *     tags: [Goods received]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: The receipt, now reversed }
 *       400: { description: Already sent back or sold }
 */
router.post(
  '/:id/undo',
  can('goodsReceipts', 'update'),
  loadScoped(GoodsReceipt),
  undoGoodsReceipt
);

export default router;
