import { CODES, accountByCode, ensureChart } from './chartOfAccounts.js';
import { postEntry, reverseEntry } from './ledger.js';
import { JOURNAL_SOURCES } from './constants.js';
import { orderLabel } from './orderPosting.js';
import MaterialMove from '../models/MaterialMove.js';
import { takeMaterial, putBackMaterial, qtyText } from './materials.js';

/**
 * Record a material/labor cost for a custom order.
 * Books Dr CUSTOM_WIP / Cr moneyAccount.
 */
export const recordCustomCost = async (order, description, amountPaisa, money, userId) => {
  await ensureChart(order.business);
  const wipAcc = await accountByCode(order.business, CODES.CUSTOM_WIP);
  const label = `${orderLabel(order)} · ${description}`;

  const entry = await postEntry({
    business: order.business,
    memo: `Custom work material — ${label}`,
    source: { kind: JOURNAL_SOURCES.CUSTOM_COST, ref: String(order._id) },
    lines: [
      { account: wipAcc._id, label, debitPaisa: amountPaisa },
      { account: money.account, label, creditPaisa: amountPaisa }
    ],
    userId
  });

  order.customCosts.push({
    description,
    amountPaisa,
    accountName: money.partner ? `${money.name} (partner)` : money.name,
    entry: entry._id,
    by: userId
  });
};

/**
 * Take material for a custom order from the raw-material store, at today's
 * average: Dr CUSTOM_WIP / Cr Raw materials. No money moves — it was paid for
 * when it was bought — so it is counted once, through this order.
 */
export const recordCustomCostFromMaterial = async (order, materialId, qty, userId) => {
  await ensureChart(order.business);
  const take = await takeMaterial(order.business, materialId, qty);
  const amountPaisa = -take.valuePaisa;
  const description = `${take.material.name} × ${qtyText(qty, take.material.unit)}`;
  const label = `${orderLabel(order)} · ${description}`;

  let entry;
  try {
    entry = await postEntry({
      business: order.business,
      memo: `Custom work material — ${label}`,
      source: { kind: JOURNAL_SOURCES.CUSTOM_COST, ref: String(order._id) },
      lines: [
        {
          account: (await accountByCode(order.business, CODES.CUSTOM_WIP))._id,
          label,
          debitPaisa: amountPaisa
        },
        {
          account: (await accountByCode(order.business, CODES.RAW_MATERIALS))._id,
          label,
          creditPaisa: amountPaisa
        }
      ],
      userId
    });
  } catch (err) {
    await putBackMaterial(order.business, materialId, qty, amountPaisa);
    throw err;
  }

  await MaterialMove.create({
    business: order.business,
    material: materialId,
    kind: 'use',
    quantity: -qty,
    valuePaisa: -amountPaisa,
    order: order._id,
    entry: entry._id,
    createdBy: userId
  });
  order.customCosts.push({
    description,
    amountPaisa,
    material: materialId,
    materialQty: qty,
    accountName: 'From materials',
    entry: entry._id,
    by: userId
  });
};

/**
 * Remove a custom cost that was logged by mistake.
 * Reverses the journal entry and removes the item from the array. Material
 * taken from the store goes back on the shelf at what it was taken at.
 */
export const removeCustomCost = async (order, costId, userId) => {
  const costIndex = order.customCosts.findIndex(c => String(c._id) === String(costId));
  if (costIndex === -1) return;
  const cost = order.customCosts[costIndex];

  if (cost.material) {
    await putBackMaterial(order.business, cost.material, cost.materialQty, cost.amountPaisa);
    await MaterialMove.deleteOne({ entry: cost.entry });
  }
  await reverseEntry(cost.entry, {
    userId,
    memo: `Reverse custom cost — order ${order.orderNumber}`
  });

  order.customCosts.splice(costIndex, 1);
};

/**
 * On delivery: move accumulated custom WIP to COGS.
 */
export const moveCustomWipToCogs = async (order, userId) => {
  const totalWipPaisa = order.customCosts.reduce((sum, c) => sum + c.amountPaisa, 0);
  if (totalWipPaisa === 0) return null;

  await ensureChart(order.business);
  const wipAcc = await accountByCode(order.business, CODES.CUSTOM_WIP);
  const cogsAcc = await accountByCode(order.business, CODES.COGS);

  return postEntry({
    business: order.business,
    memo: `Custom WIP to COGS — order ${order.orderNumber}`,
    source: { kind: JOURNAL_SOURCES.CUSTOM_COST, ref: String(order._id) },
    lines: [
      { account: cogsAcc._id, debitPaisa: totalWipPaisa },
      { account: wipAcc._id, creditPaisa: totalWipPaisa }
    ],
    userId
  });
};

/**
 * On cancel/return: write off the accumulated custom WIP.
 */
export const writeOffCustomWip = async (order, userId) => {
  const totalWipPaisa = order.customCosts.reduce((sum, c) => sum + c.amountPaisa, 0);
  if (totalWipPaisa === 0) return null;

  await ensureChart(order.business);
  const wipAcc = await accountByCode(order.business, CODES.CUSTOM_WIP);
  const writeOffAcc = await accountByCode(order.business, CODES.CUSTOM_WRITE_OFF);

  return postEntry({
    business: order.business,
    memo: `Custom WIP write-off — order ${order.orderNumber}`,
    source: { kind: JOURNAL_SOURCES.CUSTOM_COST, ref: String(order._id) },
    lines: [
      { account: writeOffAcc._id, debitPaisa: totalWipPaisa },
      { account: wipAcc._id, creditPaisa: totalWipPaisa }
    ],
    userId
  });
};
