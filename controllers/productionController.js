import mongoose from 'mongoose';
import ProductionBatch from '../models/ProductionBatch.js';
import Material from '../models/Material.js';
import Product from '../models/Product.js';
import Party from '../models/Party.js';
import asyncHandler from '../middlewares/asyncHandler.js';
import ErrorResponse from '../utils/errorResponse.js';
import { ensureChart, accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { postEntry, reverseEntry } from '../utils/ledger.js';
import { toPaisa, fromPaisa } from '../utils/money.js';
import { weightedAverageCost } from '../utils/inventory.js';
import { JOURNAL_SOURCES, PARTNER_MONEY_PREFIX } from '../utils/constants.js';
import { resolveMoney } from '../utils/moneyAccounts.js';
import {
  roundQty,
  takeBatchMaterials,
  putBackMaterial,
  recordBatchUse
} from '../utils/materials.js';

/** A cost paid from a chosen money account names it as `money:<accountId>`. */
const MONEY_PREFIX = 'money:';

const DETAIL_POPULATE = [
  { path: 'product', select: 'name articleNumber variants lowStockThreshold' },
  { path: 'lines.costLines.party', select: 'name' },
  // Which account paid each cost — shown by name on the batch.
  { path: 'lines.costLines.moneyAccount', select: 'name' },
  // Lean: just the name and unit, not the material's derived unit cost.
  { path: 'lines.costLines.material', select: 'name unit', options: { lean: true } }
];

/**
 * Validate the batch's variant lines against the product, snapshot the label,
 * and convert each variant's itemised cost lines to paisa. Each variant may
 * appear once; each must carry at least one cost line. A missing sale price
 * falls back to the variant's current price. Throws 400 on any bad line.
 */
const buildBatchLines = (product, lines, source = null, withFromStock = true) => {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new ErrorResponse('Add at least one variant to produce', 400);
  }
  const seen = new Set();
  return lines.map(l => {
    const variant = product.variants.id(l.variantId);
    if (!variant) throw new ErrorResponse('A selected variant is not on this product', 400);
    if (source && String(variant._id) === String(source._id)) {
      throw new ErrorResponse("A size can't be stitched from itself", 400);
    }
    if (seen.has(String(variant._id))) {
      throw new ErrorResponse('Each variant can appear only once in a batch', 400);
    }
    seen.add(String(variant._id));

    const quantity = Number(l.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new ErrorResponse('Quantity must be a whole number of at least 1', 400);
    }

    // A from-stock cost is the server's to write (it is priced from the source
    // size), never the client's — so any sent is dropped. A stitched line may
    // carry no other cost at all.
    const given = Array.isArray(l.costLines) ? l.costLines.filter(c => !c.fromStock) : [];
    if (!source && given.length === 0) {
      throw new ErrorResponse(`Add at least one cost for ${variant.label || 'the variant'}`, 400);
    }
    const costLines = given.map(c => {
      // From the material store: named and priced by resolveMaterialLines.
      if (c.material) {
        const materialQty = roundQty(Number(c.materialQty));
        if (!(materialQty > 0))
          throw new ErrorResponse('Enter how much material the batch uses', 400);
        return {
          label: 'Material',
          amountPaisa: 0,
          onCredit: false,
          material: c.material,
          materialQty
        };
      }
      const label = String(c.label || '').trim();
      if (!label) throw new ErrorResponse('Every cost needs a label (e.g. Cloth, Tailor)', 400);
      const amount = Number(c.amount);
      if (!(amount > 0)) throw new ErrorResponse(`"${label}" must be greater than zero`, 400);
      // `fund` is 'cash' / 'bank' (the original two), `money:<accountId>` or
      // `partner:<id>` (resolved in resolveCostMoney), or a supplier party id —
      // on credit to them.
      const fund = c.fund || 'cash';
      // Stock the business already had when it started — no money moves now.
      if (fund === 'opening') {
        return { label, amountPaisa: toPaisa(amount), onCredit: false, opening: true };
      }
      // A cost paid from an account must say WHO was paid: money that leaves with no one receiving it
      // leaves the supplier's Khata unable to answer "what did we pay them?".
      const isPaid =
        fund === 'cash' ||
        fund === 'bank' ||
        fund.startsWith(MONEY_PREFIX) ||
        fund.startsWith(PARTNER_MONEY_PREFIX);
      if (isPaid) {
        const paidTo = c.paidTo ? String(c.paidTo) : '';
        if (!paidTo) throw new ErrorResponse(`Choose who you paid for "${label}"`, 400);
        const paid = { label, amountPaisa: toPaisa(amount), onCredit: false, party: paidTo };
        if (fund === 'cash' || fund === 'bank') return { ...paid, method: fund };
        return { ...paid, moneyRef: fund };
      }
      return { label, amountPaisa: toPaisa(amount), onCredit: true, party: fund };
    });

    // The pieces moved from the source size, at its average cost right now — an
    // estimate until the batch closes and the stock is actually taken.
    if (source && withFromStock) {
      costLines.unshift({
        label: `${source.label} × ${quantity} from stock`,
        amountPaisa: Math.round(toPaisa(source.costPrice) * quantity),
        onCredit: false,
        fromStock: true
      });
    }

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

/**
 * Resolve each cost paid from a chosen money account or partner to its ledger
 * account — checked like any other money reference (this business's, open, and
 * a partner only for people who may read Partners).
 */
const resolveCostMoney = async (business, batchLines, user) => {
  for (const line of batchLines) {
    for (const c of line.costLines) {
      if (!c.moneyRef) continue;
      const ref = c.moneyRef.startsWith(MONEY_PREFIX)
        ? c.moneyRef.slice(MONEY_PREFIX.length)
        : c.moneyRef;
      c.moneyAccount = (await resolveMoney(business, { account: ref }, user)).account;
    }
  }
  return batchLines;
};

/**
 * Name each material line after its material and price it at today's average —
 * an estimate for the draft; closing fixes it at the average when the stock is
 * actually taken. Each must be an active material of this business.
 */
const resolveMaterialLines = async (business, batchLines) => {
  const costs = batchLines.flatMap(l => l.costLines.filter(c => c.material));
  if (!costs.length) return batchLines;
  const ids = [...new Set(costs.map(c => String(c.material)))];
  if (!ids.every(id => mongoose.isValidObjectId(id))) {
    throw new ErrorResponse('A chosen material is not in this business', 400);
  }
  const found = await Material.find({ _id: { $in: ids }, business }).lean();
  const byId = new Map(found.map(m => [String(m._id), m]));
  for (const c of costs) {
    const m = byId.get(String(c.material));
    if (!m) throw new ErrorResponse('A chosen material is not in this business', 400);
    if (!m.isActive) throw new ErrorResponse(`${m.name} is switched off`, 400);
    c.label = m.name;
    c.amountPaisa =
      m.stock > 0 ? Math.round((m.valuePaisa * Math.min(c.materialQty, m.stock)) / m.stock) : 0;
  }
  return batchLines;
};

/** Every cost that names a supplier — owed to them, or paid to them — must name one of this business. */
const validateCostParties = async (business, batchLines) => {
  const ids = [
    ...new Set(
      batchLines.flatMap(l =>
        (l.costLines || []).filter(c => c.onCredit || c.party).map(c => String(c.party))
      )
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

/** The size a stitching batch takes from — it must be on this product. */
const sourceFor = (prod, id) => {
  if (!id) return null;
  const variant = prod.variants.id(id);
  if (!variant) throw new ErrorResponse('That size is not on this product', 400);
  return variant;
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
  const raw = await acc(CODES.RAW_MATERIALS);
  const opening = await acc(CODES.OPENING_BALANCES);

  const debits = [];
  const groups = new Map();
  // Paid to a supplier: their payable is raised and cleared in the same entry, so the Khata shows the
  // bill AND the payment (as goods-received "paid now" does) and the balance ends where it began.
  const settles = new Map();
  for (const line of batch.lines) {
    for (const c of line.costLines || []) {
      // Stock moved between sizes: nothing was spent, so nothing posts.
      if (c.fromStock) continue;
      const amt = c.amountPaisa || 0;
      if (amt <= 0) continue;
      debits.push({
        account: inventory._id,
        product: batch.product,
        batch: batch._id,
        label: c.material
          ? `${c.label} ×${c.materialQty} · ${line.variantLabel}`
          : `${c.label} · ${line.variantLabel}`,
        debitPaisa: amt
      });
      let key, cl;
      if (c.material) {
        // Out of the material store, not paid: stock became this article.
        key = 'material';
        cl = { account: raw._id, creditPaisa: 0 };
      } else if (c.opening) {
        // Already on the shelf when the business started: opening, not a payment.
        key = 'opening';
        cl = { account: opening._id, creditPaisa: 0 };
      } else if (c.onCredit) {
        key = `payable:${c.party}`;
        cl = { account: payable._id, party: c.party, creditPaisa: 0 };
      } else if (c.party) {
        key = `payable:${c.party}`;
        cl = { account: payable._id, party: c.party, creditPaisa: 0 };
        const from = c.moneyAccount || (c.method === 'bank' ? bank._id : cash._id);
        const sk = `${c.party}|${from}`;
        const s = settles.get(sk) || { party: c.party, account: from, paisa: 0 };
        s.paisa += amt;
        settles.set(sk, s);
      } else if (c.moneyAccount) {
        key = `money:${c.moneyAccount}`;
        cl = { account: c.moneyAccount, creditPaisa: 0 };
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

  // A stitch with no other cost moves stock only — there is no entry to post.
  if (debits.length === 0) return null;

  return postEntry({
    business: batch.business,
    memo: `${memoPrefix} — ${articleOf(prod)}`,
    source: { kind: JOURNAL_SOURCES.BATCH, ref: String(batch._id) },
    lines: [
      ...debits,
      ...groups.values(),
      ...[...settles.values()].flatMap(s => [
        { account: payable._id, party: s.party, debitPaisa: s.paisa },
        { account: s.account, creditPaisa: s.paisa }
      ])
    ],
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

  const source = sourceFor(prod, req.body.sourceVariantId);
  const batchLines = buildBatchLines(prod, lines, source);
  await validateCostParties(business, batchLines);
  await resolveCostMoney(business, batchLines, req.user);
  await resolveMaterialLines(business, batchLines);
  await ensureChart(business);

  const batch = await ProductionBatch.create({
    business,
    product,
    sourceVariantId: source?._id,
    sourceVariantLabel: source?.label,
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

  const source = sourceFor(prod, req.body.sourceVariantId);
  const batchLines = buildBatchLines(prod, req.body.lines, source);
  await validateCostParties(batch.business, batchLines);
  await resolveCostMoney(batch.business, batchLines, req.user);
  await resolveMaterialLines(batch.business, batchLines);
  batch.sourceVariantId = source?._id;
  batch.sourceVariantLabel = source?.label;
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

  // A stitched batch keeps its source and its from-stock lines exactly as they
  // closed (below) — they were priced when the stock actually moved.
  const stitchedFrom = batch.sourceVariantId
    ? { _id: batch.sourceVariantId, label: batch.sourceVariantLabel }
    : null;
  const corrected = buildBatchLines(prod, req.body.lines, stitchedFrom, false);
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
  // The material a closed batch took left the store at that day's average;
  // changing it would mean re-taking stock at a different price. So material
  // lines stay exactly as they were and keep their amounts.
  const materialKey = line =>
    (line.costLines || [])
      .filter(c => c.material)
      .map(c => `${c.material}:${c.materialQty}`)
      .sort()
      .join('|');
  for (const fixed of corrected) {
    const old = batch.lines.find(l => String(l.variantId) === String(fixed.variantId));
    if (materialKey(fixed) !== materialKey(old)) {
      return next(
        new ErrorResponse(
          'The material a closed batch used can not be changed — only its other costs',
          400
        )
      );
    }
    const oldMaterial = old.costLines.filter(c => c.material);
    const oldFromStock = old.costLines.filter(c => c.fromStock);
    fixed.costLines = [
      ...oldFromStock.map(c => c.toObject()),
      ...fixed.costLines.filter(c => !c.material),
      ...oldMaterial.map(c => c.toObject())
    ];
  }
  await validateCostParties(batch.business, corrected);
  await resolveCostMoney(batch.business, corrected, req.user);

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

  batch.closeEntry = entry?._id;
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

  const unnamed = batch.lines
    .flatMap(l => l.costLines || [])
    .find(c => !c.onCredit && !c.opening && !c.material && !c.fromStock && !c.party);
  if (unnamed) {
    return next(
      new ErrorResponse(
        `Choose who you paid for "${unnamed.label}" — open the batch and pick the supplier before closing`,
        400
      )
    );
  }

  await ensureChart(batch.business);
  // Take the batch's material from the store now, fixing each line's amount at
  // today's average — all or nothing, so a short material closes nothing.
  const taken = await takeBatchMaterials(batch);
  // Pieces taken out of the source size (stitching) — returned if closing fails.
  let sourceTaken = 0;
  const putBack = async () => {
    for (const t of taken) {
      await putBackMaterial(batch.business, t.cost.material, t.qty, t.valuePaisa);
    }
    if (sourceTaken) {
      await Product.updateOne(
        { _id: batch.product, 'variants._id': batch.sourceVariantId },
        { $inc: { 'variants.$.stock': sourceTaken, totalStock: sourceTaken } }
      );
    }
  };

  // Stitching: the pieces come out of the source size. This must happen BEFORE
  // the product is loaded below — that document is saved at the end, and one
  // loaded earlier would write the source's old stock back over this.
  if (batch.sourceVariantId) {
    const total = batch.lines.reduce((s, l) => s + l.quantity, 0);
    const current = await Product.findById(batch.product).select('variants').lean();
    const source = current?.variants.find(v => String(v._id) === String(batch.sourceVariantId));
    if (!source) {
      await putBack();
      return next(
        new ErrorResponse('The size this batch stitches from is no longer on the product', 400)
      );
    }
    const result = await Product.updateOne(
      {
        _id: batch.product,
        variants: { $elemMatch: { _id: batch.sourceVariantId, stock: { $gte: total } } }
      },
      { $inc: { 'variants.$.stock': -total, totalStock: -total } }
    );
    if (result.modifiedCount !== 1) {
      await putBack();
      return next(
        new ErrorResponse(`Only ${source.stock} ${source.label} in stock — ${total} needed`, 400)
      );
    }
    sourceTaken = total;
    // Price each line's moved pieces at the source's average cost, now.
    for (const line of batch.lines) {
      for (const c of line.costLines) {
        if (c.fromStock) c.amountPaisa = Math.round(toPaisa(source.costPrice) * line.quantity);
      }
    }
  }

  // Actual cost = the sum of every variant's itemised cost lines.
  const allCosts = batch.lines.flatMap(l => l.costLines || []);
  const totalPaisa = allCosts.reduce((s, c) => s + (c.amountPaisa || 0), 0);
  // (A stitch of stock that carried no cost is still just a move between sizes.)
  if (totalPaisa <= 0 && !batch.sourceVariantId) {
    await putBack();
    return next(new ErrorResponse('Batch cost must be greater than zero', 400));
  }

  const prod = await Product.findById(batch.product);
  let entry;
  try {
    entry = await postBatchEntry(batch, prod, req.user.id);
  } catch (err) {
    await putBack();
    throw err;
  }
  await recordBatchUse(batch, taken, entry?._id, req.user.id);

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
  batch.closeEntry = entry?._id;
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
