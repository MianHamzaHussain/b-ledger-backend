import Product from '../models/Product.js';
import Party from '../models/Party.js';
import asyncHandler from '../middlewares/asyncHandler.js';
import ErrorResponse from '../utils/errorResponse.js';
import { resolveMoney } from '../utils/moneyAccounts.js';
import { toPaisa } from '../utils/money.js';
import { PARTY_TYPES } from '../utils/constants.js';
import {
  receiveGoods,
  returnToSupplier,
  returnableOf,
  undoReceipt
} from '../utils/goodsReceipt.js';

const DETAIL_POPULATE = [{ path: 'party', select: 'name phone type' }];

/**
 * A receipt as the detail page needs it: each line with what is still on the
 * shelf and what can still go back (never more than either).
 */
const withStock = async receipt => {
  await receipt.populate(DETAIL_POPULATE);
  const products = await Product.find(
    { _id: { $in: receipt.lines.map(l => l.product) } },
    'variants._id variants.stock'
  ).lean();
  const stockOf = new Map();
  for (const p of products) for (const v of p.variants) stockOf.set(String(v._id), v.stock);

  const data = receipt.toObject();
  data.lines = data.lines.map(line => {
    const inStock = stockOf.get(String(line.variantId)) ?? 0;
    return { ...line, inStock, returnable: returnableOf(line, inStock) };
  });
  return data;
};

/**
 * @desc   List goods receipts (lean — see routes for the projection)
 * @route  GET /api/v1/goods-receipts  (goodsReceipts:read — scoped)
 */
export const getGoodsReceipts = asyncHandler(async (req, res) => {
  res.status(200).json(res.advancedResults);
});

/**
 * @desc   One receipt, with its lines' stock and its send-backs
 * @route  GET /api/v1/goods-receipts/:id  (goodsReceipts:read — scoped)
 */
export const getGoodsReceipt = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await withStock(req.resource) });
});

/**
 * @desc   Record a supplier's delivery: stock and articles go in, the supplier
 *         is owed (or paid now). Existing articles add stock; new ones are made.
 * @route  POST /api/v1/goods-receipts  (goodsReceipts:create — scoped)
 */
export const createGoodsReceipt = asyncHandler(async (req, res, next) => {
  const { business, party, date, note, lines, paidNow, account, method } = req.body;

  const supplier = await Party.findOne({ _id: party, business, type: PARTY_TYPES.SUPPLIER });
  if (!supplier) return next(new ErrorResponse('Choose a supplier of this business', 400));

  const rawLines = lines.map(line =>
    line.newProduct
      ? {
          newProduct: {
            name: line.newProduct.name,
            variants: line.newProduct.variants.map(v => ({
              label: v.label,
              salePrice: v.salePrice,
              quantity: v.quantity,
              unitCostPaisa: toPaisa(v.unitCost)
            }))
          }
        }
      : {
          product: line.product,
          variantId: line.variantId,
          quantity: line.quantity,
          unitCostPaisa: toPaisa(line.unitCost)
        }
  );

  const paidNowPaisa = paidNow ? toPaisa(paidNow) : 0;
  const money =
    paidNowPaisa > 0 ? await resolveMoney(business, { account, method }, req.user) : null;

  const receipt = await receiveGoods({
    business,
    supplier,
    date,
    note,
    rawLines,
    paidNowPaisa,
    money,
    userId: req.user.id
  });
  res.status(201).json({ success: true, data: await withStock(receipt) });
});

/**
 * @desc   Send pieces back to the supplier — credited at what they billed
 * @route  POST /api/v1/goods-receipts/:id/returns  (goodsReceipts:update — scoped)
 */
export const returnGoods = asyncHandler(async (req, res) => {
  const receipt = await returnToSupplier({
    receipt: req.resource,
    items: req.body.lines,
    date: req.body.date,
    note: req.body.note,
    userId: req.user.id
  });
  res.status(201).json({ success: true, data: await withStock(receipt) });
});

/**
 * @desc   Undo a delivery nothing has happened to (nothing sent back or sold)
 * @route  POST /api/v1/goods-receipts/:id/undo  (goodsReceipts:update — scoped)
 */
export const undoGoodsReceipt = asyncHandler(async (req, res) => {
  const receipt = await undoReceipt({ receipt: req.resource, userId: req.user.id });
  res.status(200).json({ success: true, data: await withStock(receipt) });
});
