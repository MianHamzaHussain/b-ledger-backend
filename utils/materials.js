import Material from '../models/Material.js';
import MaterialMove from '../models/MaterialMove.js';
import ErrorResponse from './errorResponse.js';

/**
 * The one place a raw material's stock and value change. Every change also moves
 * the Raw materials account by the same value (the caller posts that), so the
 * account always equals Σ material values.
 */

/** Quantities are kept to 3 places so 0.1 + 0.2 metres stays 0.3. */
export const roundQty = n => Math.round(n * 1000) / 1000;

/** Units that don't take an "s": 2 kg, 3 dozen. */
const SAME_PLURAL = new Set(['kg', 'dozen']);

/** "12.5 metres", "1 cone" — how a quantity reads in errors and memos. */
export const qtyText = (qty, unit) => {
  const n = roundQty(qty);
  return `${n} ${n === 1 || SAME_PLURAL.has(unit) ? unit : `${unit}s`}`;
};

/**
 * What taking `qty` is worth at moving average (paisa). Taking the last of the
 * stock takes all the value left, so rounding never strands paisa.
 */
export const valueOfTaking = (material, qty) =>
  qty >= material.stock
    ? material.valuePaisa
    : Math.round((material.valuePaisa * qty) / material.stock);

/**
 * Apply a change to a material. `change(current)` returns the signed
 * `{ qty, valuePaisa }` to add — computed from the CURRENT row, so a take is
 * valued at the average at that moment.
 *
 * Optimistic: the write matches only if stock and value are still what were
 * read, so two batches closing at once can't both take the last cone. A lost
 * race re-reads and retries. Resolves `{ material, qty, valuePaisa }` (the row
 * as it was before).
 */
export const changeMaterial = async (business, materialId, change) => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await Material.findOne({ _id: materialId, business }).lean();
    if (!current) throw new ErrorResponse('Material not found in this business', 404);

    const { qty, valuePaisa } = change(current);
    const stock = roundQty(current.stock + qty);
    if (stock < 0) {
      throw new ErrorResponse(
        `Not enough ${current.name} — only ${qtyText(current.stock, current.unit)} left`,
        400
      );
    }
    const value = current.valuePaisa + valuePaisa;
    if (value < 0)
      throw new ErrorResponse(`${current.name} can not be worth less than nothing`, 400);

    const result = await Material.updateOne(
      { _id: current._id, stock: current.stock, valuePaisa: current.valuePaisa },
      { $set: { stock, valuePaisa: value } }
    );
    if (result.modifiedCount === 1) return { material: current, qty, valuePaisa };
  }
  throw new ErrorResponse('That material is busy — please try again', 409);
};

/** Take `qty` out at the current average. */
export const takeMaterial = (business, materialId, qty) =>
  changeMaterial(business, materialId, m => ({ qty: -qty, valuePaisa: -valueOfTaking(m, qty) }));

/** Put back exactly what a take removed (undoing a failed batch close). */
export const putBackMaterial = (business, materialId, qty, valuePaisa) =>
  changeMaterial(business, materialId, () => ({ qty, valuePaisa }));

/**
 * Take every material a batch's cost lines use, fixing each line's amount at the
 * average right now. All or nothing: if one is short, what was already taken is
 * put back before the error is thrown. Resolves the takes, for the history.
 */
export const takeBatchMaterials = async batch => {
  const taken = [];
  try {
    for (const line of batch.lines) {
      for (const c of line.costLines || []) {
        if (!c.material) continue;
        const take = await takeMaterial(batch.business, c.material, c.materialQty);
        taken.push({ cost: c, qty: c.materialQty, valuePaisa: -take.valuePaisa });
        c.amountPaisa = -take.valuePaisa;
      }
    }
  } catch (err) {
    for (const t of taken) {
      await putBackMaterial(batch.business, t.cost.material, t.qty, t.valuePaisa);
    }
    throw err;
  }
  return taken;
};

/** Record what a closed batch took, so each material's history shows it. */
export const recordBatchUse = (batch, taken, entryId, userId) =>
  taken.length
    ? MaterialMove.insertMany(
        taken.map(t => ({
          business: batch.business,
          material: t.cost.material,
          kind: 'use',
          quantity: -t.qty,
          valuePaisa: -t.valuePaisa,
          batch: batch._id,
          product: batch.product,
          entry: entryId,
          createdBy: userId
        }))
      )
    : [];
