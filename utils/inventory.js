/**
 * Weighted-average inventory costing.
 *
 * When a new batch of stock arrives at a different unit cost than what's already
 * on the shelf, the value of *every* unit is re-averaged — so profit on a later
 * sale reflects a blended, stable cost rather than jumping with each purchase.
 * It's the standard, simplest-to-trust method for interchangeable stock like
 * this (backend CLAUDE.md — FINANCE_MODULE_PLAN §7).
 *
 * All amounts here are in rupees (the product model stores prices in rupees).
 *
 * @returns the new average unit cost, rounded to 2 decimals.
 */
export const weightedAverageCost = (existingQty, existingCost, addedQty, addedCost) => {
  const oldQty = Math.max(0, Number(existingQty) || 0);
  const oldCost = Math.max(0, Number(existingCost) || 0);
  const newQty = Math.max(0, Number(addedQty) || 0);
  const newCost = Math.max(0, Number(addedCost) || 0);

  const totalQty = oldQty + newQty;
  if (totalQty === 0) return 0;

  const blended = (oldQty * oldCost + newQty * newCost) / totalQty;
  return Math.round(blended * 100) / 100;
};
