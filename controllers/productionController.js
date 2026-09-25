import ProductionBatch from '../models/ProductionBatch.js';
import Product from '../models/Product.js';
import Party from '../models/Party.js';
import asyncHandler from '../middlewares/asyncHandler.js';
import ErrorResponse from '../utils/errorResponse.js';
import { ensureChart, accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { postEntry, reverseEntry } from '../utils/ledger.js';
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

/** "Kurta (A1B2)" — how a batch's article reads in ledger memos. */
const articleOf = prod => (prod ? `${prod.name} (${prod.articleNumber})` : 'production');

/**
 * Post a batch's cost to the ledger: Dr Inventory / Cr cash|bank|payable.
 *
 * Each cost posts its OWN labelled inventory debit under the article, so the
 * ledger shows exactly what the batch was made of ("Cloth · Default", …). The
 * credit side is grouped by funding: one payable per supplier — so they see it
 * owed — plus cash / bank for what was paid. Shared by close and correction.
 */
const postBatchEntry = async (batch, prod, userId, memoPrefix = 'Production') => {
  const acc = code => accountByCode(batch.business, code);
  const inventory = await acc(CODES.INVENTORY);
  const payable = await acc(CODES.ACCOUNTS_PAYABLE);
  const cash = await acc(CODES.CASH);
  const bank = await acc(CODES.BANK);

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

  return postEntry({
    business: batch.business,
    memo: `${memoPrefix} — ${articleOf(prod)}`,
    source: { kind: JOURNAL_SOURCES.BATCH, ref: String(batch._id) },
    lines: [...debits, ...groups.values()],
    userId
  });
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
 * @desc   Edit a draft batch's lines / funding. A closed batch goes through
 *         `correctClosedBatch` instead — admin only, costs only.
 * @route  PUT /api/v1/production/:id  (production:update — scoped)
 */
export const updateBatch = asyncHandler(async (req, res, next) => {
  const batch = req.resource;
  if (batch.status !== 'open') return correctClosedBatch(req, res, next);

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
 * Correct a closed batch's costs — a cost entered wrong only surfaces once the
 * supplier's bill lands, often after the batch was closed. Admin only: it
 * rewrites what inventory cost, which every margin since has been built on.
 *
 * Only the cost lines may change. Variants and quantities are fixed because the
 * stock they added has already been sold from; sale prices were already applied
 * to the product and are edited there.
 *
 * History is never edited in place — the close entry is REVERSED and the
 * corrected one posted, so the ledger shows the correction. Each variant's cost
 * difference is then split by what is left of the batch:
 *   • the share on units still in stock is re-averaged into the variant's cost;
 *   • the share on units already sold was expensed at the old cost, so it is
 *     trued up in COGS — otherwise inventory would carry value for goods gone.
 */
const correctClosedBatch = async (req, res, next) => {
  const batch = req.resource;
  // Admin = the full-access role; roles are data, never matched by name.
  if (!req.user.role?.fullAccess) {
    return next(new ErrorResponse('Only an admin can correct a closed batch', 403));
  }

  const prod = await Product.findOne({ _id: batch.product, business: batch.business });
  if (!prod) return next(new ErrorResponse('Product not found in this business', 404));

  const corrected = buildBatchLines(prod, req.body.lines);
  const sameShape =
    corrected.length === batch.lines.length &&
    corrected.every(c => {
      const old = batch.lines.find(l => String(l.variantId) === String(c.variantId));
      return old && old.quantity === c.quantity;
    });
  if (!sameShape) {
    return next(
      new ErrorResponse(
        'Only the costs of a closed batch can be corrected — its variants and quantities are fixed',
        400
      )
    );
  }
  await validateCostParties(batch.business, corrected);

  // Per variant: old vs corrected total, split by how much of the batch is left.
  const costOf = line => (line.costLines || []).reduce((s, c) => s + (c.amountPaisa || 0), 0);
  let soldDeltaPaisa = 0;
  for (const line of batch.lines) {
    const fixed = corrected.find(c => String(c.variantId) === String(line.variantId));
    const deltaPaisa = costOf(fixed) - costOf(line);
    line.costLines = fixed.costLines;
    if (!deltaPaisa) continue;

    const variant = prod.variants.id(line.variantId);
    const stock = Math.max(0, variant?.stock || 0);
    const soldUnits = line.quantity - Math.min(stock, line.quantity);
    const soldShare = Math.round((deltaPaisa * soldUnits) / line.quantity);
    soldDeltaPaisa += soldShare;

    if (variant && stock > 0) {
      const valuePaisa = toPaisa(variant.costPrice) * stock + (deltaPaisa - soldShare);
      variant.costPrice = fromPaisa(Math.max(0, Math.round(valuePaisa / stock)));
    }
  }

  const article = articleOf(prod);
  if (batch.closeEntry) {
    await reverseEntry(batch.closeEntry, {
      userId: req.user.id,
      memo: `Correction (reversal) — ${article}`
    });
  }
  const entry = await postBatchEntry(batch, prod, req.user.id, 'Production (corrected)');

  if (soldDeltaPaisa) {
    const inventory = (await accountByCode(batch.business, CODES.INVENTORY))._id;
    const cogs = (await accountByCode(batch.business, CODES.COGS))._id;
    const amt = Math.abs(soldDeltaPaisa);
    // Cost went up ⇒ sold goods cost more (Dr COGS); down ⇒ they cost less.
    const [dr, cr] = soldDeltaPaisa > 0 ? [cogs, inventory] : [inventory, cogs];
    await postEntry({
      business: batch.business,
      memo: `Cost correction on units already sold — ${article}`,
      source: { kind: JOURNAL_SOURCES.BATCH, ref: String(batch._id) },
      lines: [
        { account: dr, product: batch.product, batch: batch._id, debitPaisa: amt },
        { account: cr, product: batch.product, batch: batch._id, creditPaisa: amt }
      ],
      userId: req.user.id
    });
  }

  prod.updatedBy = req.user.id;
  await prod.save();

  batch.closeEntry = entry._id;
  batch.updatedBy = req.user.id;
  await batch.save();

  res.status(200).json({ success: true, data: await batch.populate(DETAIL_POPULATE) });
};

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

  const prod = await Product.findById(batch.product);
  const entry = await postBatchEntry(batch, prod, req.user.id);

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
