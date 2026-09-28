import { CODES, accountByCode, ensureChart } from './chartOfAccounts.js';
import { postEntry, reverseEntry } from './ledger.js';
import { JOURNAL_SOURCES } from './constants.js';
import { orderLabel } from './orderPosting.js';

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
 * Remove a custom cost that was logged by mistake.
 * Reverses the journal entry and removes the item from the array.
 */
export const removeCustomCost = async (order, costId, userId) => {
  const costIndex = order.customCosts.findIndex(c => String(c._id) === String(costId));
  if (costIndex === -1) return;
  const cost = order.customCosts[costIndex];

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
