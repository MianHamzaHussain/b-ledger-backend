import mongoose from 'mongoose';
import Product from '../models/Product.js';
import GoodsReceipt from '../models/GoodsReceipt.js';
import { escapeRegex } from '../utils/escapeRegex.js';
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
 * @desc   One row per supplier we have received goods from — newest delivery first — so the screen
 *         shows suppliers, not a wall of near-identical deliveries. Name search is a literal,
 *         case-insensitive match. Cost fields ride the router's `hideCosts`, so the total delivered
 *         is only visible with "See costs". What we OWE is not here: that is the supplier's Khata.
 * @route  GET /api/v1/goods-receipts/suppliers?business=&search=&page=&limit=  (goodsReceipts:read — scoped)
 */
export const getReceiptSuppliers = asyncHandler(async (req, res, next) => {
  const { business, search } = req.query;
  if (!business) return next(new ErrorResponse('Select a business', 400));
  const allowed = req.accessFilter?.business?.$in;
  if (allowed && !allowed.map(String).includes(String(business))) {
    return next(new ErrorResponse('Business not found', 404));
  }
  if (!mongoose.isValidObjectId(business))
    return next(new ErrorResponse('Business not found', 404));

  const limit = Math.min(Math.max(Number(req.query.limit) || 5, 1), 50);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const needle = String(search ?? '').trim();

  const [result] = await GoodsReceipt.aggregate([
    { $match: { business: new mongoose.Types.ObjectId(String(business)), status: 'received' } },
    {
      $group: {
        _id: '$party',
        lastDeliveryAt: { $max: '$date' },
        deliveries: { $sum: 1 },
        pieces: { $sum: { $sum: '$lines.quantity' } },
        sentBackPieces: { $sum: { $sum: '$lines.quantityReturned' } },
        totalCostPaisa: { $sum: '$totalCostPaisa' }
      }
    },
    { $lookup: { from: 'parties', localField: '_id', foreignField: '_id', as: 'party' } },
    { $unwind: '$party' },
    ...(needle
      ? [{ $match: { 'party.name': { $regex: escapeRegex(needle), $options: 'i' } } }]
      : []),
    { $sort: { lastDeliveryAt: -1, _id: 1 } },
    {
      $facet: {
        rows: [{ $skip: (page - 1) * limit }, { $limit: limit }],
        total: [{ $count: 'n' }]
      }
    }
  ]);

  const total = result.total[0]?.n ?? 0;
  const data = result.rows.map(r => ({
    party: r._id,
    name: r.party.name,
    lastDeliveryAt: r.lastDeliveryAt,
    deliveries: r.deliveries,
    pieces: r.pieces,
    sentBackPieces: r.sentBackPieces,
    totalCostPaisa: r.totalCostPaisa
  }));

  res.status(200).json({
    success: true,
    count: data.length,
    total,
    pagination: page * limit < total ? { next: { page: page + 1, limit } } : {},
    data
  });
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
 * @desc   Change the note on a delivery (nothing else — money and stock are fixed
 *         once recorded; a wrong delivery is undone and entered again)
 * @route  PATCH /api/v1/goods-receipts/:id  (goodsReceipts:update — scoped)
 */
export const updateGoodsReceiptNote = asyncHandler(async (req, res) => {
  // updateOne, not save(): save() checks the document version, so it would collide
  // with a send-back or undo that bumps it at the same moment — and a note is not
  // worth failing either of those.
  await GoodsReceipt.updateOne(
    { _id: req.resource._id },
    { $set: { note: req.body.note, updatedBy: req.user.id } }
  );
  const receipt = await GoodsReceipt.findById(req.resource._id);
  res.status(200).json({ success: true, data: await withStock(receipt) });
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
