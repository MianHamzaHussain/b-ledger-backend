import Business from '../models/Business.js';
import { ensureChart, accountByCode, CODES } from './chartOfAccounts.js';
import { postEntry } from './ledger.js';
import { toPaisa } from './money.js';
import { JOURNAL_SOURCES } from './constants.js';

/**
 * The accounting behind an order's lifecycle, kept out of the controller so the
 * order flow stays readable and these rules live in one auditable place.
 *
 * Revenue and COGS are recognised at **delivery** (not at create) — the correct
 * accrual point, and it keeps order creation free of ledger side-effects. The
 * courier's COD sits as a receivable until they remit; the delivery fee becomes
 * an expense at that moment. All amounts convert rupees → integer paisa.
 */

const cogsPaisaOf = order =>
  order.items.reduce((sum, i) => sum + toPaisa(i.unitCost) * i.quantity, 0);

/** "Order #0034 · TCS0349912345" — the courier statement row label. */
const orderLabel = order =>
  `Order #${order.orderNumber}${order.trackingId ? ` · ${order.trackingId}` : ''}`;

/**
 * On delivery: recognise the sale and its cost of goods. The amount still owed
 * (`codAmount`) becomes a receivable — but who owes it, and net of what, depends
 * on how the order ships:
 *
 *   • Courier order — the courier keeps its delivery fee and withholds FBR taxes
 *     from the COD, so we book the courier's receivable at the **net** it will
 *     actually pay and expense the fee + taxes now.
 *   • Walk-in / counter sale (no courier) — there is no courier, no fee and no
 *     tax; the buyer simply owes the full balance, sub-ledgered to their
 *     customer party (Accounts Receivable).
 *
 *   Dr COD-receivable (NET) [courier]  Dr Delivery + WHT + Sales tax    ┐
 *   — or — Dr A/R (full) [customer]                                     ├ Cr Sales (total)
 *   Dr Cash (any advance / counter payment)                            ┘
 *   Dr COGS  Cr Inventory   (only if the items carry a cost)
 */
export const postOrderSale = async (order, userId) => {
  await ensureChart(order.business);

  const totalPaisa = toPaisa(order.total);
  const codPaisa = toPaisa(order.codAmount);
  const advancePaisa = toPaisa(order.advanceAmount || 0);
  const cogsPaisa = cogsPaisaOf(order);
  const acc = code => accountByCode(order.business, code);
  const label = orderLabel(order);

  const lines = [];

  if (totalPaisa > 0) {
    if (codPaisa > 0) {
      if (order.courier) {
        const business = await Business.findById(order.business).select('codTax');
        const { deliveryPaisa, whtPaisa, salesTaxPaisa, bankPaisa, whtIsAsset } = computeRemittance(
          codPaisa,
          order.deliveryChargePaisa || 0,
          business?.codTax || {}
        );
        // The net is what the courier owes us — sub-ledgered to it.
        if (bankPaisa > 0) {
          lines.push({
            account: (await acc(CODES.COD_RECEIVABLE))._id,
            party: order.courier,
            label,
            debitPaisa: bankPaisa
          });
        }
        if (deliveryPaisa > 0) {
          lines.push({
            account: (await acc(CODES.DELIVERY_CHARGES))._id,
            label,
            debitPaisa: deliveryPaisa
          });
        }
        if (whtPaisa > 0) {
          // Registered ⇒ reclaimable asset; unregistered ⇒ a plain cost.
          lines.push({
            account: (await acc(whtIsAsset ? CODES.WHT_RECEIVABLE : CODES.WITHHOLDING_TAX))._id,
            label,
            debitPaisa: whtPaisa
          });
        }
        if (salesTaxPaisa > 0) {
          lines.push({
            account: (await acc(CODES.SALES_TAX))._id,
            label,
            debitPaisa: salesTaxPaisa
          });
        }
      } else {
        // Counter sale on credit — the full balance is owed by the customer, no
        // courier deductions. Sub-ledgered to the customer party if we have one.
        lines.push({
          account: (await acc(CODES.ACCOUNTS_RECEIVABLE))._id,
          party: order.customerParty || undefined,
          label,
          debitPaisa: codPaisa
        });
      }
    }
    if (advancePaisa > 0) {
      lines.push({ account: (await acc(CODES.CASH))._id, debitPaisa: advancePaisa });
    }
    lines.push({ account: (await acc(CODES.SALES))._id, creditPaisa: totalPaisa });
  }

  if (cogsPaisa > 0) {
    lines.push({ account: (await acc(CODES.COGS))._id, debitPaisa: cogsPaisa });
    lines.push({ account: (await acc(CODES.INVENTORY))._id, creditPaisa: cogsPaisa });
  }

  if (lines.length < 2) return null;

  return postEntry({
    business: order.business,
    memo: `Sale — order ${order.orderNumber}`,
    source: { kind: JOURNAL_SOURCES.ORDER, ref: String(order._id) },
    lines,
    userId
  });
};

/**
 * Split a COD remittance into its parts — the single source of truth for the
 * money math, shared by the ledger posting below and the order-detail preview
 * (so the "you'll receive" figure on screen is exactly what gets booked).
 *
 * The courier withholds FBR taxes on COD before the cash banks. How the WHT is
 * treated depends on the business: a registered one can reclaim it (an ASSET —
 * Advance Tax), an unregistered one cannot (an EXPENSE). Sales tax is always a
 * cost. All inputs and outputs are integer paisa.
 */
export const computeRemittance = (codPaisa, deliveryChargePaisa, codTax = {}) => {
  const deliveryPaisa = Math.max(0, Number(deliveryChargePaisa) || 0);
  const whtPaisa = Math.round((codPaisa * (Number(codTax.whtPercent) || 0)) / 100);
  const salesTaxPaisa = Math.round((codPaisa * (Number(codTax.salesTaxPercent) || 0)) / 100);
  const bankPaisa = codPaisa - deliveryPaisa - whtPaisa - salesTaxPaisa;
  return {
    deliveryPaisa,
    whtPaisa,
    salesTaxPaisa,
    bankPaisa,
    whtIsAsset: Boolean(codTax.registered)
  };
};

/**
 * When the balance owed is settled, clear its receivable into cash/bank. Which
 * receivable, and how much, mirrors how the sale was booked:
 *
 *   • Courier order — the courier pays the NET (fee + taxes were booked at
 *     delivery), clearing COD-receivable into the bank:
 *       Dr Bank (net)   Cr COD-receivable (net) [courier]
 *   • Walk-in / counter sale — the customer pays the full outstanding balance in
 *     cash, clearing their A/R:
 *       Dr Cash (owed)  Cr A/R (owed) [customer]
 *
 * `deliveryChargeRupees` is accepted for signature compatibility; the amount is
 * derived from the order so the party's balance nets to zero either way.
 */
export const postOrderRemittance = async (order, deliveryChargeRupees, userId) => {
  await ensureChart(order.business);

  const codPaisa = toPaisa(order.codAmount);
  if (codPaisa <= 0) return null; // nothing was outstanding
  const acc = code => accountByCode(order.business, code);
  const label = orderLabel(order);

  // Counter sale on credit — the customer pays cash, clearing their A/R in full.
  if (!order.courier) {
    return postEntry({
      business: order.business,
      memo: `Payment received — order ${order.orderNumber}`,
      source: { kind: JOURNAL_SOURCES.ORDER, ref: String(order._id) },
      lines: [
        { account: (await acc(CODES.CASH))._id, debitPaisa: codPaisa },
        {
          account: (await acc(CODES.ACCOUNTS_RECEIVABLE))._id,
          party: order.customerParty || undefined,
          label,
          creditPaisa: codPaisa
        }
      ],
      userId
    });
  }

  const business = await Business.findById(order.business).select('codTax');
  const { bankPaisa } = computeRemittance(
    codPaisa,
    order.deliveryChargePaisa || 0,
    business?.codTax || {}
  );
  if (bankPaisa <= 0) return null;

  return postEntry({
    business: order.business,
    memo: `COD received — order ${order.orderNumber}`,
    source: { kind: JOURNAL_SOURCES.ORDER, ref: String(order._id) },
    lines: [
      { account: (await acc(CODES.BANK))._id, debitPaisa: bankPaisa },
      {
        account: (await acc(CODES.COD_RECEIVABLE))._id,
        party: order.courier,
        label,
        creditPaisa: bankPaisa
      }
    ],
    userId
  });
};

/** A return's courier charge: Dr Return charges  Cr Cash. */
export const postReturnCharge = async (order, returnChargeRupees, userId) => {
  await ensureChart(order.business);
  const chargePaisa = toPaisa(Number(returnChargeRupees) || 0);
  if (chargePaisa <= 0) return null;

  return postEntry({
    business: order.business,
    memo: `Return charge — order ${order.orderNumber}`,
    source: { kind: JOURNAL_SOURCES.ORDER, ref: String(order._id) },
    lines: [
      {
        account: (await accountByCode(order.business, CODES.RETURN_CHARGES))._id,
        debitPaisa: chargePaisa
      },
      { account: (await accountByCode(order.business, CODES.CASH))._id, creditPaisa: chargePaisa }
    ],
    userId
  });
};
