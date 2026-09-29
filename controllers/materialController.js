import Material from '../models/Material.js';
import MaterialMove from '../models/MaterialMove.js';
import Party from '../models/Party.js';
import JournalEntry from '../models/JournalEntry.js';
import asyncHandler from '../middlewares/asyncHandler.js';
import ErrorResponse from '../utils/errorResponse.js';
import { ensureChart, accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { postEntry, reverseEntry } from '../utils/ledger.js';
import { toPaisa } from '../utils/money.js';
import { resolveMoney } from '../utils/moneyAccounts.js';
import { JOURNAL_SOURCES } from '../utils/constants.js';
import { changeMaterial, roundQty, qtyText, valueOfTaking } from '../utils/materials.js';

/** The list's lean projection — `unitCostPaisa` is derived from stock and value. */
export const MATERIAL_LIST_FIELDS = 'name unit stock valuePaisa lowStockAt isActive business';

const MOVE_POPULATE = [
  { path: 'batch', select: '_id' },
  { path: 'product', select: 'name articleNumber' },
  { path: 'order', select: 'orderNumber customerName' },
  { path: 'party', select: 'name' }
];

const source = material => ({ kind: JOURNAL_SOURCES.MATERIAL, ref: String(material._id) });

/** A name already used in this business reads as a 400, not a raw E11000. */
const saveUnique = async save => {
  try {
    return await save();
  } catch (err) {
    if (err?.code === 11000)
      throw new ErrorResponse('A material with that name already exists', 400);
    throw err;
  }
};

/**
 * @desc   List raw materials
 * @route  GET /api/v1/materials  (materials:read — scoped)
 */
export const getMaterials = asyncHandler(async (req, res) => {
  res.status(200).json(res.advancedResults);
});

/**
 * @desc   A material with its history, newest first
 * @route  GET /api/v1/materials/:id  (materials:read — scoped)
 */
export const getMaterial = asyncHandler(async (req, res) => {
  const moves = await MaterialMove.find({ material: req.resource._id })
    .sort({ date: -1, createdAt: -1 })
    .limit(200)
    .populate(MOVE_POPULATE)
    .lean();
  res.status(200).json({ success: true, data: { ...req.resource.toJSON(), moves } });
});

/**
 * @desc   Add a material to the list — with no stock; stock comes in by buying.
 * @route  POST /api/v1/materials  (materials:create — scoped)
 */
export const createMaterial = asyncHandler(async (req, res) => {
  const { business, name, unit, lowStockAt, note } = req.body;
  const material = await saveUnique(() =>
    Material.create({ business, name, unit, lowStockAt, note, createdBy: req.user.id })
  );
  res.status(201).json({ success: true, data: material });
});

/**
 * @desc   Rename, re-unit or switch off a material. The unit is fixed once it has
 *         any history — 10 cones can't quietly become 10 kg.
 * @route  PUT /api/v1/materials/:id  (materials:update — scoped)
 */
export const updateMaterial = asyncHandler(async (req, res, next) => {
  const material = req.resource;
  const { name, unit, lowStockAt, note, isActive } = req.body;
  if (unit && unit !== material.unit && (await MaterialMove.exists({ material: material._id }))) {
    return next(
      new ErrorResponse('The unit can not change once the material has been bought or used', 400)
    );
  }
  if (name !== undefined) material.name = name;
  if (unit !== undefined) material.unit = unit;
  if (lowStockAt !== undefined) material.lowStockAt = lowStockAt ?? undefined;
  if (note !== undefined) material.note = note;
  if (isActive !== undefined) material.isActive = isActive;
  material.updatedBy = req.user.id;
  await saveUnique(() => material.save());
  res.status(200).json({ success: true, data: material });
});

/**
 * @desc   Delete a material that was never bought or used. One with history is
 *         switched off instead, so its purchases still read in the ledger.
 * @route  DELETE /api/v1/materials/:id  (materials:delete — scoped)
 */
export const deleteMaterial = asyncHandler(async (req, res, next) => {
  if (await MaterialMove.exists({ material: req.resource._id })) {
    return next(new ErrorResponse('This material has history — switch it off instead', 400));
  }
  await req.resource.deleteOne();
  res.status(200).json({ success: true, data: {} });
});

/**
 * @desc   Buy material into stock: Dr Raw materials / Cr money account, partner,
 *         or the supplier's Khata (on credit). No profit effect — the cost
 *         reaches profit through the articles made from it.
 * @route  POST /api/v1/materials/:id/purchases  (materials:create — scoped)
 */
export const buyMaterial = asyncHandler(async (req, res, next) => {
  const material = req.resource;
  const { quantity, amount, onCredit, opening, party, account, method, date, note } = req.body;
  const qty = roundQty(Number(quantity));
  const paisa = toPaisa(amount);
  const { business } = material;

  if (!material.isActive) return next(new ErrorResponse(`${material.name} is switched off`, 400));
  if (onCredit && !opening) {
    if (!party) return next(new ErrorResponse('Choose the supplier this is owed to', 400));
    if (!(await Party.exists({ _id: party, business }))) {
      return next(new ErrorResponse('That supplier is not a party of this business', 400));
    }
  }

  await ensureChart(business);
  const money =
    onCredit || opening ? null : await resolveMoney(business, { account, method }, req.user);
  const credit = opening
    ? {
        account: (await accountByCode(business, CODES.OPENING_BALANCES))._id,
        creditPaisa: paisa
      }
    : onCredit
      ? {
          account: (await accountByCode(business, CODES.ACCOUNTS_PAYABLE))._id,
          party,
          creditPaisa: paisa
        }
      : { account: money.account, creditPaisa: paisa };
  const what = `${material.name} × ${qtyText(qty, material.unit)}`;

  const entry = await postEntry({
    business,
    date,
    memo: `Bought ${what}`,
    source: source(material),
    lines: [
      {
        account: (await accountByCode(business, CODES.RAW_MATERIALS))._id,
        label: what,
        debitPaisa: paisa
      },
      { ...credit, label: what }
    ],
    userId: req.user.id
  });
  // The entry posts first so a locked period refuses before stock moves; if the
  // stock change fails, the entry is reversed so the two never disagree.
  try {
    await changeMaterial(business, material._id, () => ({ qty, valuePaisa: paisa }));
  } catch (err) {
    await reverseEntry(entry._id, { userId: req.user.id, memo: `Undo — ${what}` });
    throw err;
  }

  const move = await MaterialMove.create({
    business,
    material: material._id,
    kind: 'purchase',
    quantity: qty,
    valuePaisa: paisa,
    party: onCredit ? party : undefined,
    paidFrom: opening ? 'Already had it (opening)' : onCredit ? undefined : money.name,
    entry: entry._id,
    note,
    date: entry.date,
    createdBy: req.user.id
  });
  res.status(201).json({ success: true, data: move });
});

/**
 * @desc   Stock that left outside a batch, or a shelf count that differed.
 *         `wasted`: `quantity` used up / spoiled. `count`: `quantity` is what is
 *         really on the shelf. A loss posts Dr Material wasted / Cr Raw materials
 *         at the average; a count that finds more posts the other way.
 * @route  POST /api/v1/materials/:id/adjust  (materials:update — scoped)
 */
export const adjustMaterial = asyncHandler(async (req, res, next) => {
  const material = req.resource;
  const { kind, quantity, date, note } = req.body;
  const { business } = material;
  const given = roundQty(Number(quantity));

  let change;
  if (kind === 'wasted') {
    change = m => ({ qty: -given, valuePaisa: -valueOfTaking(m, given) });
  } else {
    change = m => {
      const delta = roundQty(given - m.stock);
      if (delta === 0)
        throw new ErrorResponse(`The count matches — ${qtyText(m.stock, m.unit)}`, 400);
      // Found more: value it at the current average (nothing to value it by if
      // the shelf was empty — it comes in at zero).
      const value =
        delta < 0
          ? -valueOfTaking(m, -delta)
          : Math.round((m.stock > 0 ? m.valuePaisa / m.stock : 0) * delta);
      return { qty: delta, valuePaisa: value };
    };
  }

  await ensureChart(business);
  const done = await changeMaterial(business, material._id, change);
  const what = `${material.name} × ${qtyText(Math.abs(done.qty), material.unit)}`;
  const label =
    kind === 'wasted'
      ? `Wasted ${what}`
      : done.qty < 0
        ? `Count short ${what}`
        : `Count found ${what}`;

  let entry;
  if (done.valuePaisa !== 0) {
    const amt = Math.abs(done.valuePaisa);
    const raw = (await accountByCode(business, CODES.RAW_MATERIALS))._id;
    const loss = (await accountByCode(business, CODES.MATERIAL_LOSS))._id;
    const [dr, cr] = done.valuePaisa < 0 ? [loss, raw] : [raw, loss];
    try {
      entry = await postEntry({
        business,
        date,
        memo: label,
        source: source(material),
        lines: [
          { account: dr, label, debitPaisa: amt },
          { account: cr, label, creditPaisa: amt }
        ],
        userId: req.user.id
      });
    } catch (err) {
      await changeMaterial(business, material._id, () => ({
        qty: -done.qty,
        valuePaisa: -done.valuePaisa
      }));
      throw err;
    }
  }

  const move = await MaterialMove.create({
    business,
    material: material._id,
    kind,
    quantity: done.qty,
    valuePaisa: done.valuePaisa,
    entry: entry?._id,
    note,
    date: entry?.date ?? date ?? new Date(),
    createdBy: req.user.id
  });
  res.status(201).json({ success: true, data: move });
});

/**
 * @desc   Undo the material's latest line when it was a purchase or adjustment
 *         entered by mistake: its entry is reversed and stock put back. Only the
 *         latest, so the average it was valued at is still exactly what it was.
 *         What a batch used is undone by the batch, never here.
 * @route  DELETE /api/v1/materials/:id/moves/:moveId  (materials:update — scoped)
 */
export const undoMaterialMove = asyncHandler(async (req, res, next) => {
  const material = req.resource;
  const move = await MaterialMove.findOne({ _id: req.params.moveId, material: material._id });
  if (!move) return next(new ErrorResponse('That line is not on this material', 404));
  if (move.kind === 'use')
    return next(
      new ErrorResponse('Material used by a batch or an order is undone there, not here', 400)
    );

  const latest = await MaterialMove.findOne({ material: material._id }).sort({ createdAt: -1 });
  if (String(latest._id) !== String(move._id)) {
    return next(new ErrorResponse('Only the latest line can be undone', 400));
  }

  await changeMaterial(material.business, material._id, () => ({
    qty: -move.quantity,
    valuePaisa: -move.valuePaisa
  }));
  if (move.entry && !(await JournalEntry.exists({ reversalOf: move.entry }))) {
    await reverseEntry(move.entry, { userId: req.user.id, memo: `Undo — ${material.name}` });
  }
  await move.deleteOne();
  res.status(200).json({ success: true, data: {} });
});
