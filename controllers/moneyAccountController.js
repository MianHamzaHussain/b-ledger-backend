import Account from '../models/Account.js';
import asyncHandler from '../middlewares/asyncHandler.js';
import ErrorResponse from '../utils/errorResponse.js';
import { postEntry, accountBalance } from '../utils/ledger.js';
import { listMoneyAccounts, createMoneyAccount, resolveMoney } from '../utils/moneyAccounts.js';
import { toPaisa, fromPaisa } from '../utils/money.js';
import { JOURNAL_SOURCES } from '../utils/constants.js';

/** True when `business` is inside the caller's scope (admins pass). */
const inScope = (req, business) => {
  const allowed = req.accessFilter?.business?.$in;
  return !allowed || allowed.map(String).includes(String(business));
};

/** Rupees for the wire; balances are kept in paisa. */
const present = row => ({ ...row, balance: fromPaisa(row.balancePaisa) });

/**
 * @desc   The business's money accounts with balances, and partners' running
 *         balances for people who may read Partners.
 * @route  GET /api/v1/finance/money-accounts?business=&includeClosed=  (journal:read — scoped)
 */
export const getMoneyAccounts = asyncHandler(async (req, res, next) => {
  const { business } = req.query;
  if (!business) return next(new ErrorResponse('Select a business', 400));
  if (!inScope(req, business)) return next(new ErrorResponse('Business not found', 404));

  const { accounts, partners } = await listMoneyAccounts(business, req.user, {
    includeClosed: req.query.includeClosed === 'true'
  });
  res.status(200).json({
    success: true,
    data: { accounts: accounts.map(present), partners: partners.map(present) }
  });
});

/**
 * @desc   Add a money account — a bank account, a JazzCash/Easypaisa wallet, or
 *         another cash box.
 * @route  POST /api/v1/finance/money-accounts  (accounts:create — scoped)
 */
export const addMoneyAccount = asyncHandler(async (req, res, next) => {
  const { business, name, kind, number } = req.body;
  if (!inScope(req, business)) return next(new ErrorResponse('Business not found', 404));
  const exists = await Account.exists({ business, name, moneyKind: { $exists: true } });
  if (exists) return next(new ErrorResponse(`There is already an account called ${name}`, 400));

  const account = await createMoneyAccount(business, { name, kind, number }, req.user.id);
  res.status(201).json({ success: true, data: account });
});

/**
 * @desc   Rename a money account, change its number, or close / reopen it. An
 *         account can close only at a zero balance, so no money goes missing
 *         from the totals; the original Cash and Main bank never close.
 * @route  PUT /api/v1/finance/money-accounts/:id  (accounts:update — scoped)
 */
export const updateMoneyAccount = asyncHandler(async (req, res, next) => {
  const account = req.resource;
  if (!account.moneyKind) return next(new ErrorResponse('That is not a money account', 404));

  const { name, number, isActive } = req.body;
  if (name != null) account.name = name;
  if (number != null) account.number = number || undefined;
  if (isActive === false && account.isActive) {
    if (account.isSystem) {
      return next(new ErrorResponse(`${account.name} is always kept open`, 400));
    }
    const balance = await accountBalance(account.business, account._id);
    if (balance !== 0) {
      return next(
        new ErrorResponse(
          `${account.name} still holds Rs ${fromPaisa(balance)} — move it out before closing`,
          400
        )
      );
    }
  }
  if (isActive != null) account.isActive = isActive;
  account.updatedBy = req.user.id;
  await account.save();
  res.status(200).json({ success: true, data: account });
});

/**
 * @desc   Move money between the business's own places — cash deposited in the
 *         bank, a wallet withdrawn to cash, a partner handing over what they
 *         collected, or the business paying a partner back. Not income or cost.
 * @route  POST /api/v1/finance/transfers  (journal:create — scoped)
 */
export const recordTransfer = asyncHandler(async (req, res, next) => {
  const { business, from, to, date, memo } = req.body;
  if (!inScope(req, business)) return next(new ErrorResponse('Business not found', 404));
  if (from === to) return next(new ErrorResponse('Choose two different places', 400));

  const paisa = toPaisa(Number(req.body.amount));
  if (!(paisa > 0)) return next(new ErrorResponse('Enter an amount greater than zero', 400));

  const source = await resolveMoney(business, { account: from }, req.user);
  const target = await resolveMoney(business, { account: to }, req.user);

  const entry = await postEntry({
    business,
    date,
    memo: memo || `${source.name} → ${target.name}`,
    source: { kind: JOURNAL_SOURCES.TRANSFER },
    lines: [
      { account: target.account, debitPaisa: paisa },
      { account: source.account, creditPaisa: paisa }
    ],
    userId: req.user.id
  });
  res.status(201).json({ success: true, data: entry });
});
