import ProductionBatch from '../models/ProductionBatch.js';
import Product from '../models/Product.js';
import Party from '../models/Party.js';
import asyncHandler from '../middlewares/asyncHandler.js';
import ErrorResponse from '../utils/errorResponse.js';
import { ensureChart, accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { postEntry } from '../utils/ledger.js';
import { toPaisa, fromPaisa } from '../utils/money.js';
import { weightedAverageCost } from '../utils/inventory.js';
import { JOURNAL_SOURCES } from '../utils/constants.js';

const DETAIL_POPULATE = [
  { path: 'product', select: 'name articleNumber variants lowStockThreshold' },
  { path: 'lines.costLines.party', select: 'name' }
];

/**
 * Validate the batch's variant lines against the product, snapshot the label,
 * and convert each variant's itemised cost lines to paisa. Each variant may
 * appear once; each must carry at least one cost line. A missing sale price
 * falls back to the variant's current price. Throws 400 on any bad line.
 */
const buildBatchLines = (product, lines) => {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new ErrorResponse('Add at least one variant to produce', 400);
  }
  const seen = new Set();
  return lines.map(l => {
    const variant = product.variants.id(l.variantId);
    if (!variant) throw new ErrorResponse('A selected variant is not on this product', 400);
    if (seen.has(String(variant._id))) {
      throw new ErrorResponse('Each variant can appear only once in a batch', 400);
    }
    seen.add(String(variant._id));

    const quantity = Number(l.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new ErrorResponse('Quantity must be a whole number of at least 1', 400);
    }

    if (!Array.isArray(l.costLines) || l.costLines.length === 0) {
      throw new ErrorResponse(`Add at least one cost for ${variant.label || 'the variant'}`, 400);
    }
    const costLines = l.costLines.map(c => {
      const label = String(c.label || '').trim();
      if (!label) throw new ErrorResponse('Every cost needs a label (e.g. Cloth, Tailor)', 400);
      const amount = Number(c.amount);
      if (!(amount > 0)) throw new ErrorResponse(`"${label}" must be greater than zero`, 400);
      // `fund` is 'cash', 'bank', or a supplier party id (→ on credit to them).
      const fund = c.fund || 'cash';
      if (fund === 'cash' || fund === 'bank') {
        return { label, amountPaisa: toPaisa(amount), method: fund, onCredit: false };
      }
      return { label, amountPaisa: toPaisa(amount), onCredit: true, party: fund };
    });

    const salePrice = l.salePrice != null ? Number(l.salePrice) : variant.salePrice;
    return {
      variantId: variant._id,
      variantLabel: variant.label || 'Default',
      quantity,
      costLines,
      salePrice
    };
  });
};

/** Every on-credit cost must name a party that belongs to this business. */
const validateCostParties = async (business, batchLines) => {
  const ids = [
    ...new Set(
      batchLines.flatMap(l => (l.costLines || []).filter(c => c.onCredit).map(c => String(c.party)))
    )
  ];
  if (!ids.length) return;
  if (ids.some(id => !id || id === 'undefined')) {
    throw new ErrorResponse('Choose the supplier for each on-credit cost', 400);
  }
  const found = await Party.countDocuments({ _id: { $in: ids }, business });
  if (found < ids.length)
    throw new ErrorResponse('A cost supplier is not a party of this business', 400);
};

/**
 * @desc   List production batches
 * @route  GET /api/v1/production  (production:read — scoped)
 */
export const getBatches = asyncHandler(async (req, res) => {
  res.status(200).json(res.advancedResults);
});

/**
 * @desc   Get a batch, with the product's current variants for the detail view
 * @route  GET /api/v1/production/:id  (production:read — scoped)
 */
export const getBatch = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await req.resource.populate(DETAIL_POPULATE) });
});

/**
 * @desc   Start a draft batch — one product, several variants, each with its
 *         own quantity and unit cost. Nothing posts until the batch is closed.
 * @route  POST /api/v1/production  (production:create — scoped)
 */
export const createBatch = asyncHandler(async (req, res, next) => {
  const { business, product, lines } = req.body;

  const prod = await Product.findOne({ _id: product, business });
  if (!prod) return next(new ErrorResponse('Product not found in this business', 404));

  const batchLines = buildBatchLines(prod, lines);
  await validateCostParties(business, batchLines);
  await ensureChart(business);

  const batch = await ProductionBatch.create({
    business,
    product,
    lines: batchLines,
    createdBy: req.user.id
  });

  res.status(201).json({ success: true, data: await batch.populate(DETAIL_POPULATE) });
});

/**
 * @desc   Edit a draft batch's lines / funding (open batches only)
 * @route  PUT /api/v1/production/:id  (production:update — scoped)
 */
export const updateBatch = asyncHandler(async (req, res, next) => {
  const batch = req.resource;
  if (batch.status !== 'open')
    return next(new ErrorResponse('A closed batch can not be edited', 400));

  const prod = await Product.findOne({ _id: batch.product, business: batch.business });
  if (!prod) return next(new ErrorResponse('Product not found in this business', 404));

  const batchLines = buildBatchLines(prod, req.body.lines);
  await validateCostParties(batch.business, batchLines);
  batch.lines = batchLines;
  batch.updatedBy = req.user.id;
  await batch.save();

  res.status(200).json({ success: true, data: await batch.populate(DETAIL_POPULATE) });
});

/**
 * @desc   Close a batch: post Dr Inventory / Cr cash|bank|payable for the whole
 *         cost, then per variant add the quantity to stock, re-average its cost,
 *         and set the (possibly adjusted) sale price.
 * @route  POST /api/v1/production/:id/close  (production:update — scoped)
 */
export const closeBatch = asyncHandler(async (req, res, next) => {
  const batch = req.resource;
  if (batch.status !== 'open') return next(new ErrorResponse('This batch is already closed', 400));
  if (!batch.lines.length)
    return next(new ErrorResponse('Add at least one variant before closing', 400));

  // Final sale-price overrides from the close review, keyed by variant.
  const overrides = {};
  if (Array.isArray(req.body.lines)) {
    for (const l of req.body.lines) {
      if (l.variantId != null && l.salePrice != null)
        overrides[String(l.variantId)] = Number(l.salePrice);
    }
  }

  await ensureChart(batch.business);
  // Actual cost = the sum of every variant's itemised cost lines.
  const allCosts = batch.lines.flatMap(l => l.costLines || []);
  const totalPaisa = allCosts.reduce((s, c) => s + (c.amountPaisa || 0), 0);
  if (totalPaisa <= 0) return next(new ErrorResponse('Batch cost must be greater than zero', 400));

  const acc = code => accountByCode(batch.business, code);
  const inventory = await acc(CODES.INVENTORY);
  const payable = await acc(CODES.ACCOUNTS_PAYABLE);
  const cash = await acc(CODES.CASH);
  const bank = await acc(CODES.BANK);
  const prod = await Product.findById(batch.product);
  const article = prod ? `${prod.name} (${prod.articleNumber})` : 'production';

  // Each cost posts its OWN labelled inventory debit under the article, so the
  // ledger shows exactly what the batch was made of ("Cloth · Default", …). The
  // credit side is grouped by funding: one payable per supplier — so they see it
  // owed — plus cash / bank for what was paid.
  const debits = [];
  const groups = new Map();
  for (const line of batch.lines) {
    for (const c of line.costLines || []) {
      const amt = c.amountPaisa || 0;
      if (amt <= 0) continue;
      debits.push({
        account: inventory._id,
        product: batch.product,
        batch: batch._id,
        label: `${c.label} · ${line.variantLabel}`,
        debitPaisa: amt
      });
      let key, cl;
      if (c.onCredit) {
        key = `payable:${c.party}`;
        cl = { account: payable._id, party: c.party, creditPaisa: 0 };
      } else if (c.method === 'bank') {
        key = 'bank';
        cl = { account: bank._id, creditPaisa: 0 };
      } else {
        key = 'cash';
        cl = { account: cash._id, creditPaisa: 0 };
      }
      const ex = groups.get(key) || cl;
      ex.creditPaisa += amt;
      groups.set(key, ex);
    }
  }

  const entry = await postEntry({
    business: batch.business,
    memo: `Production — ${article}`,
    source: { kind: JOURNAL_SOURCES.BATCH, ref: String(batch._id) },
    lines: [...debits, ...groups.values()],
    userId: req.user.id
  });

  // Per variant: independent stock, moving-average cost, and sale price.
  if (prod) {
    for (const line of batch.lines) {
      const variant = prod.variants.id(line.variantId);
      if (!variant) continue;
      variant.costPrice = weightedAverageCost(
        variant.stock,
        variant.costPrice,
        line.quantity,
        fromPaisa(line.unitCostPaisa)
      );
      variant.stock = (variant.stock || 0) + line.quantity;
      const sale = overrides[String(line.variantId)] ?? line.salePrice;
      if (sale != null && sale >= 0) {
        variant.salePrice = sale;
        line.salePrice = sale; // keep the batch record in step with what was applied
      }
    }
    prod.updatedBy = req.user.id;
    await prod.save();
  }

  batch.status = 'closed';
  batch.closeEntry = entry._id;
  batch.closedAt = new Date();
  batch.updatedBy = req.user.id;
  await batch.save();

  res.status(200).json({ success: true, data: await batch.populate(DETAIL_POPULATE) });
});

/**
 * @desc   Delete a draft batch. Open batches post nothing to the ledger, so
 *         there is nothing to unwind; closed batches are immutable history.
 * @route  DELETE /api/v1/production/:id  (production:delete — scoped)
 */
export const deleteBatch = asyncHandler(async (req, res, next) => {
  const batch = req.resource;
  if (batch.status === 'closed') {
    return next(
      new ErrorResponse('Closed batches are part of the ledger and can not be deleted', 400)
    );
  }
  await batch.deleteOne();
  res.status(200).json({ success: true, data: {} });
});
