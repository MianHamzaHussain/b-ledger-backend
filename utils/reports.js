import mongoose from 'mongoose';
import JournalEntry from '../models/JournalEntry.js';
import Order from '../models/Order.js';
import { accountByCode, CODES } from './chartOfAccounts.js';
import { ORDER_STATUS } from './constants.js';

const toId = value => new mongoose.Types.ObjectId(value);

const dateRange = (from, to) => {
  const range = {};
  if (from) range.$gte = new Date(from);
  if (to) range.$lte = new Date(to);
  return Object.keys(range).length ? range : undefined;
};

/**
 * Net per account, joined with account meta. The workhorse behind P&L and the
 * balance sheet — one aggregation, split by type in the caller.
 */
const accountNets = async (business, { from, to } = {}) => {
  const entryMatch = { business: toId(business) };
  const range = dateRange(from, to);
  if (range) entryMatch.date = range;

  return JournalEntry.aggregate([
    { $match: entryMatch },
    { $unwind: '$lines' },
    {
      $group: {
        _id: '$lines.account',
        debit: { $sum: '$lines.debitPaisa' },
        credit: { $sum: '$lines.creditPaisa' }
      }
    },
    { $lookup: { from: 'accounts', localField: '_id', foreignField: '_id', as: 'a' } },
    { $unwind: '$a' },
    { $sort: { 'a.code': 1 } },
    {
      $project: {
        _id: 0,
        account: '$a._id',
        code: '$a.code',
        name: '$a.name',
        type: '$a.type',
        debitPaisa: '$debit',
        creditPaisa: '$credit'
      }
    }
  ]);
};

/** Income − expenses over a period. Income shows as credit-normal, expense debit-normal. */
export const profitAndLoss = async (business, opts = {}) => {
  const nets = await accountNets(business, opts);

  const income = nets
    .filter(r => r.type === 'income')
    .map(r => ({ ...r, amountPaisa: r.creditPaisa - r.debitPaisa }));
  const expense = nets
    .filter(r => r.type === 'expense')
    .map(r => ({ ...r, amountPaisa: r.debitPaisa - r.creditPaisa }));

  const incomePaisa = income.reduce((s, r) => s + r.amountPaisa, 0);
  const expensePaisa = expense.reduce((s, r) => s + r.amountPaisa, 0);

  return { income, expense, incomePaisa, expensePaisa, netProfitPaisa: incomePaisa - expensePaisa };
};

/** Assets = Liabilities + Equity (incl. accumulated profit) as of a date. */
export const balanceSheet = async (business, { asOf } = {}) => {
  const nets = await accountNets(business, { to: asOf });

  const assets = nets
    .filter(r => r.type === 'asset')
    .map(r => ({ ...r, amountPaisa: r.debitPaisa - r.creditPaisa }));
  const liabilities = nets
    .filter(r => r.type === 'liability')
    .map(r => ({ ...r, amountPaisa: r.creditPaisa - r.debitPaisa }));
  const equity = nets
    .filter(r => r.type === 'equity')
    .map(r => ({ ...r, amountPaisa: r.creditPaisa - r.debitPaisa }));

  const incomePaisa = nets
    .filter(r => r.type === 'income')
    .reduce((s, r) => s + (r.creditPaisa - r.debitPaisa), 0);
  const expensePaisa = nets
    .filter(r => r.type === 'expense')
    .reduce((s, r) => s + (r.debitPaisa - r.creditPaisa), 0);
  const retainedPaisa = incomePaisa - expensePaisa; // unclosed profit sits in equity

  const assetsPaisa = assets.reduce((s, r) => s + r.amountPaisa, 0);
  const liabilitiesPaisa = liabilities.reduce((s, r) => s + r.amountPaisa, 0);
  const equityAccountsPaisa = equity.reduce((s, r) => s + r.amountPaisa, 0);
  const totalEquityPaisa = equityAccountsPaisa + retainedPaisa;

  return {
    assets,
    liabilities,
    equity,
    retainedPaisa,
    assetsPaisa,
    liabilitiesPaisa,
    totalEquityPaisa,
    balanced: assetsPaisa === liabilitiesPaisa + totalEquityPaisa
  };
};

/**
 * Profit per product, from **delivered** orders (the realised sales channel).
 * Amounts are rupees, matching the order model. Excludes returns.
 */
export const productProfitability = async (business, { from, to } = {}) => {
  const match = { business: toId(business), status: ORDER_STATUS.DELIVERED };
  const range = dateRange(from, to);
  if (range) match.createdAt = range;

  return Order.aggregate([
    { $match: match },
    { $unwind: '$items' },
    {
      $group: {
        _id: '$items.product',
        name: { $first: '$items.productName' },
        quantity: { $sum: '$items.quantity' },
        revenue: { $sum: { $multiply: ['$items.unitPrice', '$items.quantity'] } },
        cost: { $sum: { $multiply: ['$items.unitCost', '$items.quantity'] } }
      }
    },
    {
      $project: {
        _id: 0,
        product: '$_id',
        name: 1,
        quantity: 1,
        revenue: 1,
        cost: 1,
        profit: { $subtract: ['$revenue', '$cost'] }
      }
    },
    { $sort: { profit: -1 } }
  ]);
};

/** Every party's net — receivables (they owe us) and payables (we owe them). */
export const partyLedgerReport = async business => {
  const rows = await JournalEntry.aggregate([
    { $match: { business: toId(business) } },
    { $unwind: '$lines' },
    { $match: { 'lines.party': { $ne: null } } },
    {
      $group: {
        _id: '$lines.party',
        debit: { $sum: '$lines.debitPaisa' },
        credit: { $sum: '$lines.creditPaisa' }
      }
    },
    { $lookup: { from: 'parties', localField: '_id', foreignField: '_id', as: 'p' } },
    { $unwind: '$p' },
    {
      $project: {
        _id: 0,
        party: '$p._id',
        name: '$p.name',
        type: '$p.type',
        balancePaisa: { $subtract: ['$debit', '$credit'] }
      }
    }
  ]);

  const receivables = rows.filter(r => r.balancePaisa > 0);
  const payables = rows
    .filter(r => r.balancePaisa < 0)
    .map(r => ({ ...r, balancePaisa: -r.balancePaisa }));

  return {
    receivables,
    payables,
    receivablePaisa: receivables.reduce((s, r) => s + r.balancePaisa, 0),
    payablePaisa: payables.reduce((s, r) => s + r.balancePaisa, 0)
  };
};

/** COD still held by each courier — expected vs remitted, from the COD account.
 *  Couriers are parties now, so COD is grouped by the courier party. */
export const courierReconciliation = async business => {
  const cod = await accountByCode(business, CODES.COD_RECEIVABLE);

  const rows = await JournalEntry.aggregate([
    { $match: { business: toId(business) } },
    { $unwind: '$lines' },
    { $match: { 'lines.account': cod._id } },
    {
      $group: {
        _id: '$lines.party',
        debit: { $sum: '$lines.debitPaisa' },
        credit: { $sum: '$lines.creditPaisa' }
      }
    },
    { $lookup: { from: 'parties', localField: '_id', foreignField: '_id', as: 'p' } },
    {
      $project: {
        _id: 0,
        courier: '$_id',
        name: { $ifNull: [{ $first: '$p.name' }, 'No courier'] },
        outstandingPaisa: { $subtract: ['$debit', '$credit'] }
      }
    },
    { $sort: { outstandingPaisa: -1 } }
  ]);

  return { rows, outstandingPaisa: rows.reduce((s, r) => s + r.outstandingPaisa, 0) };
};
