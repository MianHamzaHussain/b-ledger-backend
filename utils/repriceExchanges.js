import Order from '../models/Order.js';
import { applyExchangeKeep, exchangeKeep, undoExchangeCosts } from './courierCosts.js';
import { logActivity } from './orderActivity.js';
import { fromPaisa, toPaisa } from './money.js';
import { BEFORE_DISPATCH, EXCHANGE_COST_RULE } from './constants.js';

/**
 * ONE-OFF (2026-11-26). Replacements made before the exchange rule changed charge the customer for BOTH parcels. Those
 * that have not been dispatched yet can still be re-worked under the new rule (the difference + the new parcel only):
 * nothing has been printed on a courier slip, so their COD is still free to change.
 *
 * Re-worked: a return-first replacement before dispatch, made under the old rule (no `exchangeCostRule`). Its kept-back
 * entry is reversed, the costs are worked out again and kept back, and the order's timeline says so.
 * Left alone: anything dispatched or later (its COD is on the courier's slip), and a swap at the door (its difference
 * was already paid to us directly — giving part of it back is a refund, done by a person).
 *
 * `apply: false` (the default) only lists what would change. Safe to run twice: a re-worked order has the new rule.
 */
export const repriceExchanges = async ({ apply = false } = {}) => {
  const replacements = await Order.find({
    exchangeOf: { $ne: null },
    exchangeCostRule: { $exists: false },
    status: { $in: BEFORE_DISPATCH },
    isSwap: { $ne: true }
  });
  const changes = [];
  for (const order of replacements) {
    // eslint-disable-next-line no-await-in-loop
    const original = await Order.findById(order.exchangeOf);
    if (!original) continue;
    const creditPaisa = order.customerMoney
      .filter(
        m =>
          m.kind === 'transfer-in' && m.accountName === `from exchange of #${original.orderNumber}`
      )
      .reduce((sum, m) => sum + m.amountPaisa, 0);
    // eslint-disable-next-line no-await-in-loop
    const keep = await exchangeKeep(original, {
      newTotalPaisa: toPaisa(order.total),
      creditPaisa
    });
    const change = {
      business: String(order.business),
      orderNumber: order.orderNumber,
      originalNumber: original.orderNumber,
      codBefore: order.codAmount,
      codAfter: keep.owes ? fromPaisa(keep.codPaisa) : 0
    };
    changes.push(change);
    if (!apply) continue;

    const by = order.createdBy;
    // eslint-disable-next-line no-await-in-loop
    await undoExchangeCosts(order, by);
    order.exchangeCostRule = EXCHANGE_COST_RULE.NEW_PARCEL;
    logActivity(order, null, {
      kind: 'money',
      text: 'Exchange costs worked out again: only the new parcel’s courier cost is charged',
      from: `COD Rs ${change.codBefore}`,
      to: `COD Rs ${change.codAfter}`,
      system: true
    });
    // eslint-disable-next-line no-await-in-loop
    await order.save();
    // eslint-disable-next-line no-await-in-loop
    if (keep.owes) await applyExchangeKeep(order, keep, by);
    // eslint-disable-next-line no-await-in-loop
    change.codSaved = (await Order.findById(order._id)).codAmount;
  }
  return { changes };
};
