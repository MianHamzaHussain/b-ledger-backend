import Consignment from '../models/Consignment.js';
import Product from '../models/Product.js';
import Party from '../models/Party.js';
import asyncHandler from '../middlewares/asyncHandler.js';
import ErrorResponse from '../utils/errorResponse.js';
import { reserveStock, releaseStock } from '../utils/stock.js';
import { ensureChart, accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { postEntry, reverseEntry, partyBalance } from '../utils/ledger.js';
import { toPaisa, fromPaisa } from '../utils/money.js';
import { JOURNAL_SOURCES, PARTY_TYPES } from '../utils/constants.js';

const DETAIL_POPULATE = [
  { path: 'party', select: 'name phone type' },
  { path: 'lines.product', select: 'name articleNumber' }
];

/**
 * Validate the reseller belongs to the business and is actually a reseller.
 */
const resolveReseller = async (business, partyId) => {
  if (!partyId) throw new ErrorResponse('Please choose the reseller', 400);
  const party = await Party.findOne({ _id: partyId, business, type: PARTY_TYPES.RESELLER });
  if (!party) throw new ErrorResponse('That party is not a reseller of this business', 400);
  return party;
};

/**
 * Validate the requested lines against this business's products and snapshot the
 * name, cost and agreed price at issue time. Returns the line docs plus the
 * `{ product, variantId, quantity }` list used to reserve stock. Throws 400 on
 * any bad line. Shared by issue and edit.
 */
const buildLines = async (business, rawLines) => {
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    throw new ErrorResponse('Add at least one product line', 400);
  }
  const lines = [];
  const stock = [];
  for (const raw of rawLines) {
    const product = await Product.findOne({ _id: raw.product, business });
    if (!product) throw new ErrorResponse('A selected product is not in this business', 400);
    const variant = product.variants.id(raw.variantId);
    if (!variant) throw new ErrorResponse(`Choose a variant for ${product.name}`, 400);

    const qty = Number(raw.quantity);
    if (!Number.isInteger(qty) || qty < 1) {
      throw new ErrorResponse(
        `Quantity for ${product.name} must be a whole number of at least 1`,
        400
      );
    }
    const price = Number(raw.unitPrice);
    if (!(price >= 0)) throw new ErrorResponse(`Enter the agreed price for ${product.name}`, 400);

    lines.push({
      product: product._id,
      variantId: variant._id,
      productName: product.name,
      variantLabel: variant.label || 'Default',
      quantityIssued: qty,
      unitCostPaisa: toPaisa(variant.costPrice),
      unitPricePaisa: toPaisa(price)
    });
    stock.push({ product: product._id, variantId: variant._id, quantity: qty });
  }
  return { lines, stock };
};

/** The Goods-on-Approval entry for an issue: goods leave inventory but stay ours,
 *  parked at cost. Product-tagged, never party-tagged (units-out live on the lot;
 *  the reseller's money balance stays pure A/R until he keeps some). */
const postIssueEntry = async (consignment, reseller, userId) => {
  const acc = code => accountByCode(consignment.business, code);
  const lines = [];
  for (const l of consignment.lines) {
    const costPaisa = l.unitCostPaisa * l.quantityIssued;
    if (costPaisa <= 0) continue;
    lines.push({
      account: (await acc(CODES.GOODS_ON_APPROVAL))._id,
      product: l.product,
      debitPaisa: costPaisa
    });
    lines.push({
      account: (await acc(CODES.INVENTORY))._id,
      product: l.product,
      creditPaisa: costPaisa
    });
  }
  if (lines.length < 2) return null;
  return postEntry({
    business: consignment.business,
    memo: `Goods to ${reseller.name} — consignment #${consignment.consignmentNumber}`,
    source: { kind: JOURNAL_SOURCES.CONSIGNMENT, ref: String(consignment._id) },
    lines,
    userId
  });
};

/**
 * @desc   List consignments (lean — see routes for the projection)
 * @route  GET /api/v1/consignments  (consignments:read — scoped)
 */
export const getConsignments = asyncHandler(async (req, res) => {
  res.status(200).json(res.advancedResults);
});

/**
 * @desc   One consignment with its lines (each carrying `remaining`) and the
 *         reseller's current money balance.
 * @route  GET /api/v1/consignments/:id  (consignments:read — scoped)
 */
export const getConsignment = asyncHandler(async (req, res) => {
  const consignment = req.resource;
  await consignment.populate(DETAIL_POPULATE);
  const resellerBalancePaisa = await partyBalance(consignment.business, consignment.party._id);
  res.status(200).json({
    success: true,
    data: {
      ...consignment.toObject(),
      resellerBalance: fromPaisa(resellerBalancePaisa),
      // The money axis in rupees for the detail's payment card.
      billed: fromPaisa(consignment.billedPaisa),
      paid: fromPaisa(consignment.paidPaisa),
      outstanding: fromPaisa(consignment.billedPaisa - consignment.paidPaisa)
    }
  });
});

/**
 * @desc   Hand goods to a reseller on sale-or-return. Stock leaves inventory but
 *         stays yours (Goods on Approval) — no sale yet. Multi-line.
 * @route  POST /api/v1/consignments  (consignments:create — scoped)
 */
export const createConsignment = asyncHandler(async (req, res, next) => {
  const { business } = req.body;
  if (!business) return next(new ErrorResponse('Please select a business', 400));

  const reseller = await resolveReseller(business, req.body.party);
  const { lines, stock } = await buildLines(business, req.body.lines);

  await ensureChart(business);
  await reserveStock(stock); // atomic — throws (and unwinds) if any line is short

  try {
    const consignment = await Consignment.create({
      business,
      party: reseller._id,
      lines,
      createdBy: req.user.id
    });

    const entry = await postIssueEntry(consignment, reseller, req.user.id);
    if (entry) {
      consignment.issueEntry = entry._id;
      await consignment.save();
    }

    await consignment.populate(DETAIL_POPULATE);
    res.status(201).json({ success: true, data: consignment });
  } catch (err) {
    await releaseStock(stock);
    next(err);
  }
});

/**
 * @desc   Edit a consignment — allowed only while untouched (no line returned or
 *         sold), mirroring an order editable only before dispatch. Reverses the
 *         issue + restocks, then re-issues with the new lines.
 * @route  PUT /api/v1/consignments/:id  (consignments:update — scoped)
 */
export const updateConsignment = asyncHandler(async (req, res, next) => {
  const consignment = req.resource;
  if (!consignment.isUntouched) {
    return next(
      new ErrorResponse(
        'This consignment already has returns or sales and can not be edited. Return or sell its lines instead.',
        400
      )
    );
  }

  const business = consignment.business;
  const reseller = req.body.party
    ? await resolveReseller(business, req.body.party)
    : await resolveReseller(business, consignment.party);
  const { lines, stock } = await buildLines(business, req.body.lines);

  // Free the old reservation, take the new one (standalone DB — unwind by hand).
  const oldStock = consignment.lines.map(l => ({
    product: l.product,
    variantId: l.variantId,
    quantity: l.quantityIssued
  }));
  await releaseStock(oldStock);
  try {
    await reserveStock(stock);
  } catch (err) {
    await reserveStock(oldStock); // roll back to the pre-edit reservation
    return next(err);
  }

  // Reverse the old Goods-on-Approval entry and re-post for the new lines.
  if (consignment.issueEntry) {
    await reverseEntry(consignment.issueEntry, {
      userId: req.user.id,
      memo: `Edit of consignment #${consignment.consignmentNumber}`
    });
  }
  consignment.party = reseller._id;
  consignment.lines = lines;
  consignment.updatedBy = req.user.id;
  const entry = await postIssueEntry(consignment, reseller, req.user.id);
  consignment.issueEntry = entry ? entry._id : undefined;
  await consignment.save();

  await consignment.populate(DETAIL_POPULATE);
  res.status(200).json({ success: true, data: consignment });
});

/**
 * @desc   Delete a consignment — only while untouched. Reverses the issue and
 *         restocks; a consignment with any return/sale is kept for its history.
 * @route  DELETE /api/v1/consignments/:id  (consignments:delete — scoped)
 */
export const deleteConsignment = asyncHandler(async (req, res, next) => {
  const consignment = req.resource;
  if (!consignment.isUntouched) {
    return next(
      new ErrorResponse(
        'This consignment has returns or sales and can not be deleted — it is part of the record.',
        400
      )
    );
  }

  await releaseStock(
    consignment.lines.map(l => ({
      product: l.product,
      variantId: l.variantId,
      quantity: l.quantityIssued
    }))
  );
  if (consignment.issueEntry) {
    await reverseEntry(consignment.issueEntry, {
      userId: req.user.id,
      memo: `Deleted consignment #${consignment.consignmentNumber}`
    });
  }
  await consignment.deleteOne();
  res.status(200).json({ success: true, data: {} });
});

/** Find a line on the consignment, or 404. */
const findLine = (consignment, lineId, next) => {
  const line = consignment.lines.id(lineId);
  if (!line) {
    next(new ErrorResponse('That line is not on this consignment', 404));
    return null;
  }
  return line;
};

/**
 * @desc   Reseller returns some of a line — back to stock, no profit impact.
 * @route  POST /api/v1/consignments/:id/return  (consignments:update — scoped)
 */
export const returnLine = asyncHandler(async (req, res, next) => {
  const consignment = req.resource;
  const line = findLine(consignment, req.body.lineId, next);
  if (!line) return;

  const qty = Number(req.body.quantity);
  const remaining = line.quantityIssued - line.quantityReturned - line.quantitySold;
  if (!Number.isInteger(qty) || qty < 1)
    return next(new ErrorResponse('Enter a whole quantity', 400));
  if (qty > remaining)
    return next(new ErrorResponse(`Only ${remaining} of ${line.productName} still out`, 400));

  await ensureChart(consignment.business);
  await releaseStock([{ product: line.product, variantId: line.variantId, quantity: qty }]);

  const costPaisa = line.unitCostPaisa * qty;
  if (costPaisa > 0) {
    await postEntry({
      business: consignment.business,
      memo: `Returned ${qty} × ${line.variantLabel} — consignment #${consignment.consignmentNumber}`,
      source: { kind: JOURNAL_SOURCES.CONSIGNMENT, ref: String(consignment._id) },
      lines: [
        {
          account: (await accountByCode(consignment.business, CODES.INVENTORY))._id,
          product: line.product,
          debitPaisa: costPaisa
        },
        {
          account: (await accountByCode(consignment.business, CODES.GOODS_ON_APPROVAL))._id,
          product: line.product,
          creditPaisa: costPaisa
        }
      ],
      userId: req.user.id
    });
  }

  line.quantityReturned += qty;
  consignment.updatedBy = req.user.id;
  await consignment.save();

  await consignment.populate(DETAIL_POPULATE);
  res.status(200).json({ success: true, data: consignment });
});

/**
 * @desc   Reseller keeps/sells some of a line — NOW it's a real sale (he owes the
 *         money): A/R rises against his name, revenue + COGS recognised.
 * @route  POST /api/v1/consignments/:id/sell  (consignments:update — scoped)
 */
export const sellLine = asyncHandler(async (req, res, next) => {
  const consignment = req.resource;
  const line = findLine(consignment, req.body.lineId, next);
  if (!line) return;

  const qty = Number(req.body.quantity);
  const remaining = line.quantityIssued - line.quantityReturned - line.quantitySold;
  if (!Number.isInteger(qty) || qty < 1)
    return next(new ErrorResponse('Enter a whole quantity', 400));
  if (qty > remaining)
    return next(new ErrorResponse(`Only ${remaining} of ${line.productName} still out`, 400));

  const pricePaisa =
    req.body.unitPrice != null ? toPaisa(Number(req.body.unitPrice)) : line.unitPricePaisa;
  const revenuePaisa = pricePaisa * qty;
  if (revenuePaisa <= 0)
    return next(new ErrorResponse('Sale price must be greater than zero', 400));

  await ensureChart(consignment.business);
  const cogsPaisa = line.unitCostPaisa * qty;
  const acc = code => accountByCode(consignment.business, code);
  const lines = [
    {
      account: (await acc(CODES.ACCOUNTS_RECEIVABLE))._id,
      party: consignment.party,
      debitPaisa: revenuePaisa
    },
    { account: (await acc(CODES.SALES))._id, creditPaisa: revenuePaisa }
  ];
  if (cogsPaisa > 0) {
    lines.push({
      account: (await acc(CODES.COGS))._id,
      product: line.product,
      debitPaisa: cogsPaisa
    });
    lines.push({
      account: (await acc(CODES.GOODS_ON_APPROVAL))._id,
      product: line.product,
      creditPaisa: cogsPaisa
    });
  }

  await postEntry({
    business: consignment.business,
    memo: `Kept ${qty} × ${line.variantLabel} — consignment #${consignment.consignmentNumber}`,
    source: { kind: JOURNAL_SOURCES.CONSIGNMENT, ref: String(consignment._id) },
    lines,
    userId: req.user.id
  });

  line.quantitySold += qty;
  // Money axis: he now owes for these — grows the amount billed on this consignment.
  consignment.billedPaisa += revenuePaisa;
  consignment.updatedBy = req.user.id;
  await consignment.save();

  await consignment.populate(DETAIL_POPULATE);
  res.status(200).json({ success: true, data: consignment });
});

/**
 * @desc   Record a payment from the reseller against what he's kept. Clears his
 *         receivable into cash/bank and advances the consignment's payment axis.
 * @route  POST /api/v1/consignments/:id/payment  (consignments:update — scoped)
 */
export const recordPayment = asyncHandler(async (req, res, next) => {
  const consignment = req.resource;
  const outstandingPaisa = consignment.billedPaisa - consignment.paidPaisa;
  if (outstandingPaisa <= 0) {
    return next(new ErrorResponse('Nothing is outstanding on this consignment', 400));
  }

  // Default to settling the whole outstanding balance; allow a smaller part-payment.
  const amountPaisa = req.body.amount != null ? toPaisa(Number(req.body.amount)) : outstandingPaisa;
  if (!(amountPaisa > 0)) return next(new ErrorResponse('Enter an amount greater than zero', 400));
  if (amountPaisa > outstandingPaisa) {
    return next(new ErrorResponse(`Only ${fromPaisa(outstandingPaisa)} is outstanding`, 400));
  }

  const method = req.body.method === 'bank' ? CODES.BANK : CODES.CASH;
  await ensureChart(consignment.business);
  await postEntry({
    business: consignment.business,
    memo: `Payment from reseller — consignment #${consignment.consignmentNumber}`,
    source: { kind: JOURNAL_SOURCES.CONSIGNMENT, ref: String(consignment._id) },
    lines: [
      { account: (await accountByCode(consignment.business, method))._id, debitPaisa: amountPaisa },
      {
        account: (await accountByCode(consignment.business, CODES.ACCOUNTS_RECEIVABLE))._id,
        party: consignment.party,
        creditPaisa: amountPaisa
      }
    ],
    userId: req.user.id
  });

  consignment.paidPaisa += amountPaisa;
  consignment.updatedBy = req.user.id;
  await consignment.save();

  await consignment.populate(DETAIL_POPULATE);
  res.status(200).json({ success: true, data: consignment });
});
