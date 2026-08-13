import mongoose from 'mongoose';
import Account from '../models/Account.js';
import JournalEntry from '../models/JournalEntry.js';
import PeriodLock from '../models/PeriodLock.js';
import Party from '../models/Party.js';
import asyncHandler from '../middlewares/asyncHandler.js';
import ErrorResponse from '../utils/errorResponse.js';
import { ensureChart, accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { postEntry, reverseEntry, trialBalance, latestLock } from '../utils/ledger.js';
import {
  profitAndLoss,
  balanceSheet,
  productProfitability,
  partyLedgerReport,
  courierReconciliation
} from '../utils/reports.js';
import { toPaisa, fromPaisa } from '../utils/money.js';
import { ACCOUNT_TYPES, JOURNAL_SOURCES, PARTY_TYPES } from '../utils/constants.js';

/** A validated, positive paisa amount, or an ErrorResponse-throwing reject. */
const amountPaisa = raw => {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ErrorResponse('Enter an amount greater than zero', 400);
  }
  return toPaisa(value);
};

/** Cash or bank, defaulting to cash. */
const methodCode = method => (method === 'bank' ? CODES.BANK : CODES.CASH);

/** Small helper so every endpoint posts + responds identically. */
const respondPosted = async (res, params) => {
  const entry = await postEntry(params);
  res.status(201).json({ success: true, data: entry });
};

/** True when `business` is inside the caller's scope (admins pass). */
const inScope = (req, business) => {
  const allowed = req.accessFilter?.business?.$in;
  return !allowed || allowed.map(String).includes(String(business));
};

/**
 * @desc   Record owner capital — investment in, or drawings out
 * @route  POST /api/v1/finance/capital  (journal:create — scoped)
 */
export const recordCapital = asyncHandler(async (req, res) => {
  const { business, direction, method, date, memo } = req.body;
  const paisa = amountPaisa(req.body.amount);
  await ensureChart(business);

  const money = await accountByCode(business, methodCode(method));
  const capital = await accountByCode(business, CODES.OWNERS_CAPITAL);
  const drawings = await accountByCode(business, CODES.DRAWINGS);

  const lines =
    direction === 'drawings'
      ? [
          { account: drawings._id, debitPaisa: paisa },
          { account: money._id, creditPaisa: paisa }
        ]
      : [
          { account: money._id, debitPaisa: paisa },
          { account: capital._id, creditPaisa: paisa }
        ];

  await respondPosted(res, {
    business,
    date,
    memo: memo || (direction === 'drawings' ? 'Owner drawings' : 'Owner investment'),
    source: { kind: JOURNAL_SOURCES.CAPITAL },
    lines,
    userId: req.user.id
  });
});

/**
 * @desc   Record an expense — paid now, or on credit to a supplier
 * @route  POST /api/v1/finance/expenses  (journal:create — scoped)
 */
export const recordExpense = asyncHandler(async (req, res, next) => {
  const { business, category, party, product, onCredit, method, date, memo } = req.body;
  const paisa = amountPaisa(req.body.amount);
  await ensureChart(business);

  const expense = await accountByCode(business, category || CODES.MISC_EXPENSE);
  if (expense.type !== ACCOUNT_TYPES.EXPENSE) {
    return next(new ErrorResponse('That is not an expense account', 400));
  }

  if (onCredit && !party) {
    return next(new ErrorResponse('Choose the supplier this is owed to', 400));
  }

  const credit = onCredit
    ? {
        account: (await accountByCode(business, CODES.ACCOUNTS_PAYABLE))._id,
        party,
        creditPaisa: paisa
      }
    : { account: (await accountByCode(business, methodCode(method)))._id, creditPaisa: paisa };

  const debit = { account: expense._id, debitPaisa: paisa };
  if (product) debit.product = product;

  await respondPosted(res, {
    business,
    date,
    memo: memo || expense.name,
    source: { kind: JOURNAL_SOURCES.EXPENSE },
    lines: [debit, credit],
    userId: req.user.id
  });
});

/**
 * @desc   Record a payment — pay a supplier down, or collect from a reseller
 * @route  POST /api/v1/finance/payments  (journal:create — scoped)
 */
export const recordPayment = asyncHandler(async (req, res, next) => {
  const { business, party, direction, method, date, memo } = req.body;
  const paisa = amountPaisa(req.body.amount);
  if (!party) return next(new ErrorResponse('Choose the party', 400));
  await ensureChart(business);

  const money = await accountByCode(business, methodCode(method));

  let lines;
  if (direction === 'pay') {
    // We pay a supplier — reduce what we owe them.
    const payable = await accountByCode(business, CODES.ACCOUNTS_PAYABLE);
    lines = [
      { account: payable._id, party, debitPaisa: paisa },
      { account: money._id, creditPaisa: paisa }
    ];
  } else {
    // We receive from a reseller/customer — reduce what they owe us.
    const receivable = await accountByCode(business, CODES.ACCOUNTS_RECEIVABLE);
    lines = [
      { account: money._id, debitPaisa: paisa },
      { account: receivable._id, party, creditPaisa: paisa }
    ];
  }

  await respondPosted(res, {
    business,
    date,
    memo: memo || (direction === 'pay' ? 'Payment made' : 'Payment received'),
    source: { kind: JOURNAL_SOURCES.PAYMENT },
    lines,
    userId: req.user.id
  });
});

/**
 * @desc   Record salary — paid now, or accrued as owed to the employee
 * @route  POST /api/v1/finance/salary  (journal:create — scoped)
 */
export const recordSalary = asyncHandler(async (req, res, next) => {
  const { business, party, onCredit, method, date, memo } = req.body;
  const paisa = amountPaisa(req.body.amount);
  if (onCredit && !party)
    return next(new ErrorResponse('Choose the employee this is owed to', 400));
  await ensureChart(business);

  const salaries = await accountByCode(business, CODES.SALARIES);
  // The employee is tagged only on the PAYABLE (accrue) line — never on the
  // expense. Tagging the expense would make a paid employee show a debit
  // balance, as if they owed the business money.
  const credit = onCredit
    ? {
        account: (await accountByCode(business, CODES.SALARIES_PAYABLE))._id,
        party,
        creditPaisa: paisa
      }
    : { account: (await accountByCode(business, methodCode(method)))._id, creditPaisa: paisa };

  await respondPosted(res, {
    business,
    date,
    memo: memo || 'Salary',
    source: { kind: JOURNAL_SOURCES.SALARY },
    lines: [{ account: salaries._id, debitPaisa: paisa }, credit],
    userId: req.user.id
  });
});

/**
 * @desc   Record a general (manual) entry — a plain Dr one account / Cr another,
 *         the escape hatch for anything without a dedicated flow (buying an
 *         asset from cash, taking a loan, an adjustment). Always balances by
 *         construction: one amount, one debit, one credit.
 * @route  POST /api/v1/finance/manual  (journal:create — scoped)
 */
export const recordManual = asyncHandler(async (req, res, next) => {
  const { business, debitAccount, creditAccount, date, memo } = req.body;
  const paisa = amountPaisa(req.body.amount);
  if (!debitAccount || !creditAccount) {
    return next(new ErrorResponse('Choose the debit and credit accounts', 400));
  }
  if (debitAccount === creditAccount) {
    return next(new ErrorResponse('The debit and credit accounts must be different', 400));
  }
  await ensureChart(business);

  const dr = await accountByCode(business, debitAccount);
  const cr = await accountByCode(business, creditAccount);

  await respondPosted(res, {
    business,
    date,
    memo: memo || `${dr.name} → ${cr.name}`,
    source: { kind: JOURNAL_SOURCES.MANUAL },
    lines: [
      { account: dr._id, debitPaisa: paisa },
      { account: cr._id, creditPaisa: paisa }
    ],
    userId: req.user.id
  });
});

/**
 * @desc   Buy a fixed asset — something kept and used, not resold. Paid from
 *         cash/bank, or on credit to a supplier.
 * @route  POST /api/v1/finance/assets  (journal:create — scoped)
 */
export const recordAsset = asyncHandler(async (req, res, next) => {
  const { business, onCredit, party, method, date, memo } = req.body;
  const paisa = amountPaisa(req.body.amount);
  if (onCredit && !party)
    return next(new ErrorResponse('Choose the supplier this is owed to', 400));
  await ensureChart(business);

  const asset = await accountByCode(business, CODES.FIXED_ASSETS);
  const credit = onCredit
    ? {
        account: (await accountByCode(business, CODES.ACCOUNTS_PAYABLE))._id,
        party,
        creditPaisa: paisa
      }
    : { account: (await accountByCode(business, methodCode(method)))._id, creditPaisa: paisa };

  await respondPosted(res, {
    business,
    date,
    memo: memo || 'Fixed asset purchase',
    source: { kind: JOURNAL_SOURCES.ASSET },
    lines: [{ account: asset._id, debitPaisa: paisa }, credit],
    userId: req.user.id
  });
});

/**
 * @desc   A loan — money borrowed in (a liability), or repaid. On repayment the
 *         optional interest is expensed alongside the principal.
 * @route  POST /api/v1/finance/loans  (journal:create — scoped)
 */
export const recordLoan = asyncHandler(async (req, res, next) => {
  const { business, direction, method, party, date, memo } = req.body;
  const paisa = amountPaisa(req.body.amount);
  await ensureChart(business);

  // The lender is a party, so Loan Payable is sub-ledgered to it: each loan has
  // its own statement (principal in, installments out, running balance owed).
  if (!party) return next(new ErrorResponse('Choose the lender this loan is with', 400));
  const lender = await Party.findOne({ _id: party, business, type: PARTY_TYPES.LENDER });
  if (!lender) return next(new ErrorResponse('That party is not a lender of this business', 400));

  const money = await accountByCode(business, methodCode(method));
  const loan = await accountByCode(business, CODES.LOAN_PAYABLE);

  let lines;
  if (direction === 'repay') {
    // Dr Loan (principal) [+ Dr Interest] · Cr Cash/Bank (principal + interest).
    // Only the principal line is tagged to the lender — the interest is a cost,
    // not part of what's owed, so the lender's balance stays = remaining principal.
    const interestPaisa = req.body.interest != null ? toPaisa(Number(req.body.interest)) : 0;
    if (interestPaisa < 0) return next(new ErrorResponse('Interest can not be negative', 400));
    lines = [{ account: loan._id, party, debitPaisa: paisa }];
    if (interestPaisa > 0) {
      lines.push({
        account: (await accountByCode(business, CODES.INTEREST_EXPENSE))._id,
        debitPaisa: interestPaisa
      });
    }
    lines.push({ account: money._id, creditPaisa: paisa + interestPaisa });
  } else {
    // Take a loan: money in, and we now owe it — owed to this lender.
    lines = [
      { account: money._id, debitPaisa: paisa },
      { account: loan._id, party, creditPaisa: paisa }
    ];
  }

  await respondPosted(res, {
    business,
    date,
    memo:
      memo ||
      (direction === 'repay' ? `Loan installment — ${lender.name}` : `Loan from ${lender.name}`),
    source: { kind: JOURNAL_SOURCES.LOAN },
    lines,
    userId: req.user.id
  });
});

/**
 * @desc   Depreciation — spread a fixed asset's cost as it wears out. An expense
 *         matched by a contra-asset (accumulated depreciation), so the asset's
 *         book value falls without touching its original cost.
 * @route  POST /api/v1/finance/depreciation  (journal:create — scoped)
 */
export const recordDepreciation = asyncHandler(async (req, res) => {
  const { business, date, memo } = req.body;
  const paisa = amountPaisa(req.body.amount);
  await ensureChart(business);

  await respondPosted(res, {
    business,
    date,
    memo: memo || 'Depreciation',
    source: { kind: JOURNAL_SOURCES.DEPRECIATION },
    lines: [
      { account: (await accountByCode(business, CODES.DEPRECIATION))._id, debitPaisa: paisa },
      {
        account: (await accountByCode(business, CODES.ACCUMULATED_DEPRECIATION))._id,
        creditPaisa: paisa
      }
    ],
    userId: req.user.id
  });
});

/**
 * @desc   Year-end (period) close. Sweeps every income and expense account into
 *         Retained Earnings, zeroing them — so the period's profit accumulates
 *         in equity where partner distributions draw from, and the next period
 *         starts a fresh P&L. Balances by construction; returns the net profit
 *         it moved. Run it before distributing profit.
 * @route  POST /api/v1/finance/close  (journal:create — scoped)
 */
export const closePeriod = asyncHandler(async (req, res, next) => {
  const { business, date, memo } = req.body;
  await ensureChart(business);

  const { rows } = await trialBalance(business, {});

  const lines = [];
  let profitPaisa = 0;
  for (const row of rows) {
    const isPl = row.type === ACCOUNT_TYPES.INCOME || row.type === ACCOUNT_TYPES.EXPENSE;
    if (!isPl || row.netPaisa === 0) continue;
    // Zero the account by posting the opposite of its net balance.
    if (row.netPaisa > 0) lines.push({ account: row.account, creditPaisa: row.netPaisa });
    else lines.push({ account: row.account, debitPaisa: -row.netPaisa });
    // Income carries a credit balance (netPaisa < 0), expense a debit (> 0), so
    // net profit = −Σ(netPaisa) across the two.
    profitPaisa -= row.netPaisa;
  }

  if (lines.length === 0) {
    return next(new ErrorResponse('Nothing to close — no income or expense in the period', 400));
  }

  const retained = (await accountByCode(business, CODES.RETAINED_EARNINGS))._id;
  if (profitPaisa > 0) lines.push({ account: retained, creditPaisa: profitPaisa });
  else if (profitPaisa < 0) lines.push({ account: retained, debitPaisa: -profitPaisa });

  const entry = await postEntry({
    business,
    date,
    memo: memo || 'Year-end close',
    source: { kind: JOURNAL_SOURCES.CLOSING },
    lines,
    userId: req.user.id
  });

  res.status(201).json({
    success: true,
    data: { netProfit: fromPaisa(profitPaisa), entry: entry._id }
  });
});

/**
 * @desc   The chart of accounts for a business (seeded on first read)
 * @route  GET /api/v1/finance/accounts?business=  (accounts:read — scoped)
 */
export const getAccounts = asyncHandler(async (req, res, next) => {
  const { business } = req.query;
  if (!business) return next(new ErrorResponse('Select a business', 400));
  if (!inScope(req, business))
    return next(new ErrorResponse('You are not assigned to that business', 403));

  await ensureChart(business);
  const accounts = await Account.find({ business }).sort({ code: 1 });
  res.status(200).json({ success: true, count: accounts.length, data: accounts });
});

/**
 * @desc   Trial balance — every account's net; must sum to zero (integrity check)
 * @route  GET /api/v1/finance/trial-balance?business=&from=&to=  (reports:read — scoped)
 */
export const getTrialBalance = asyncHandler(async (req, res, next) => {
  const { business, from, to } = req.query;
  if (!business) return next(new ErrorResponse('Select a business', 400));
  if (!inScope(req, business))
    return next(new ErrorResponse('You are not assigned to that business', 403));

  const result = await trialBalance(business, {
    from: from ? new Date(from) : undefined,
    to: to ? new Date(to) : undefined
  });
  res.status(200).json({ success: true, data: result });
});

/** Guard shared by the report endpoints: require an in-scope business. */
const requireBusiness = (req, next) => {
  const { business } = req.query;
  if (!business) {
    next(new ErrorResponse('Select a business', 400));
    return null;
  }
  if (!inScope(req, business)) {
    next(new ErrorResponse('You are not assigned to that business', 403));
    return null;
  }
  return business;
};

/**
 * @desc   Profit & Loss for a period
 * @route  GET /api/v1/finance/reports/pnl?business=&from=&to=  (reports:read)
 */
export const getProfitAndLoss = asyncHandler(async (req, res, next) => {
  const business = requireBusiness(req, next);
  if (!business) return;
  res.status(200).json({ success: true, data: await profitAndLoss(business, req.query) });
});

/**
 * @desc   Balance sheet as of a date
 * @route  GET /api/v1/finance/reports/balance-sheet?business=&asOf=  (reports:read)
 */
export const getBalanceSheet = asyncHandler(async (req, res, next) => {
  const business = requireBusiness(req, next);
  if (!business) return;
  res
    .status(200)
    .json({ success: true, data: await balanceSheet(business, { asOf: req.query.asOf }) });
});

/**
 * @desc   Profit per product (delivered orders)
 * @route  GET /api/v1/finance/reports/product-profit?business=&from=&to=  (reports:read)
 */
export const getProductProfit = asyncHandler(async (req, res, next) => {
  const business = requireBusiness(req, next);
  if (!business) return;
  res.status(200).json({ success: true, data: await productProfitability(business, req.query) });
});

/**
 * @desc   Receivables & payables by party
 * @route  GET /api/v1/finance/reports/parties?business=  (reports:read)
 */
export const getPartyReport = asyncHandler(async (req, res, next) => {
  const business = requireBusiness(req, next);
  if (!business) return;
  res.status(200).json({ success: true, data: await partyLedgerReport(business) });
});

/**
 * @desc   Courier reconciliation — COD still with each courier
 * @route  GET /api/v1/finance/reports/courier?business=  (reports:read)
 */
export const getCourierRecon = asyncHandler(async (req, res, next) => {
  const business = requireBusiness(req, next);
  if (!business) return;
  await ensureChart(business);
  res.status(200).json({ success: true, data: await courierReconciliation(business) });
});

/**
 * @desc   The date the books are locked through (or null)
 * @route  GET /api/v1/finance/period-lock?business=  (journal:read)
 */
export const getPeriodLock = asyncHandler(async (req, res, next) => {
  const business = requireBusiness(req, next);
  if (!business) return;
  res.status(200).json({ success: true, data: { periodEnd: await latestLock(business) } });
});

/**
 * @desc   Lock the books through a date — freezes those entries
 * @route  POST /api/v1/finance/period-lock  (journal:update)
 */
export const lockPeriod = asyncHandler(async (req, res, next) => {
  const { business, periodEnd } = req.body;
  if (!business) return next(new ErrorResponse('Select a business', 400));
  if (!periodEnd) return next(new ErrorResponse('Choose a date to lock through', 400));

  const lock = await PeriodLock.create({
    business,
    periodEnd: new Date(periodEnd),
    lockedBy: req.user.id
  });
  res.status(201).json({ success: true, data: { periodEnd: lock.periodEnd } });
});

/**
 * @desc   Unlock — remove the most recent lock
 * @route  DELETE /api/v1/finance/period-lock?business=  (journal:delete)
 */
export const unlockPeriod = asyncHandler(async (req, res, next) => {
  const business = requireBusiness(req, next);
  if (!business) return;

  const lock = await PeriodLock.findOne({ business }).sort({ periodEnd: -1 });
  if (lock) await lock.deleteOne();
  res.status(200).json({ success: true, data: { periodEnd: await latestLock(business) } });
});

/**
 * @desc   The journal — every posted entry, newest first, with its lines
 *         resolved to account and party names. Each row is flagged `isReversal`
 *         (it undoes another) and `reversed` (it has already been undone), so
 *         the UI can show status and offer Reverse only where it's valid.
 * @route  GET /api/v1/finance/journal?business=&page=&limit=  (journal:read — scoped)
 */
export const getJournal = asyncHandler(async (req, res, next) => {
  const business = requireBusiness(req, next);
  if (!business) return;

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));

  const filter = { business };

  // Filter by entry type (source.kind) — "Sales" = order, plus expense, payment,
  // capital, salary, consignment, batch, opening, manual.
  if (req.query.kind) filter['source.kind'] = String(req.query.kind);

  // Search over the memo OR the name of any party tagged on the entry, so you can
  // find "Bilal" whether he's named in the memo or only on a line.
  if (req.query.search) {
    const escaped = String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(escaped, 'i');
    const parties = await Party.find({ business, name: rx }).select('_id').lean();
    filter.$or = [{ memo: rx }];
    if (parties.length) filter.$or.push({ 'lines.party': { $in: parties.map(p => p._id) } });
  }

  const total = await JournalEntry.countDocuments(filter);

  // Debit/credit totals for the current filter — the summary bar on top.
  // `aggregate` does NOT auto-cast like `find`, so the business string must be
  // an ObjectId here or the $match silently matches nothing (summary reads 0/0).
  const aggMatch = { ...filter, business: new mongoose.Types.ObjectId(String(business)) };
  const [totals] = await JournalEntry.aggregate([
    { $match: aggMatch },
    { $unwind: '$lines' },
    {
      $group: {
        _id: null,
        debitPaisa: { $sum: '$lines.debitPaisa' },
        creditPaisa: { $sum: '$lines.creditPaisa' }
      }
    }
  ]);
  const summary = {
    debitPaisa: totals?.debitPaisa || 0,
    creditPaisa: totals?.creditPaisa || 0,
    count: total
  };

  const entries = await JournalEntry.find(filter)
    .sort('-date -createdAt')
    .skip((page - 1) * limit)
    .limit(limit)
    .populate('lines.account', 'name code type')
    .populate('lines.party', 'name')
    .lean();

  // Which of these have already been reversed? One extra query, not N.
  const reversals = await JournalEntry.find({ reversalOf: { $in: entries.map(e => e._id) } })
    .select('reversalOf')
    .lean();
  const reversed = new Set(reversals.map(r => String(r.reversalOf)));

  const data = entries.map(e => ({
    ...e,
    isReversal: Boolean(e.reversalOf),
    reversed: reversed.has(String(e._id))
  }));

  res.status(200).json({
    success: true,
    count: data.length,
    total,
    summary,
    pagination: page * limit < total ? { next: { page: page + 1, limit } } : {},
    data
  });
});

/**
 * @desc   Reverse a posted entry — the audit-safe way to "undo" one. Posts a
 *         mirror entry dated today rather than editing history, so a locked
 *         period's numbers never change after the fact.
 * @route  POST /api/v1/finance/journal/:id/reverse  (journal:update — scoped)
 */
export const reverseJournalEntry = asyncHandler(async (req, res, next) => {
  const entry = req.resource; // loadScoped(JournalEntry) — 404s if out of scope

  if (entry.reversalOf) {
    return next(new ErrorResponse('A reversal entry can not itself be reversed', 400));
  }
  if (await JournalEntry.exists({ reversalOf: entry._id })) {
    return next(new ErrorResponse('This entry has already been reversed', 400));
  }

  const reversal = await reverseEntry(entry._id, {
    userId: req.user.id,
    memo: req.body.memo
  });
  res.status(201).json({ success: true, data: reversal });
});
