import Partner from '../models/Partner.js';
import Account from '../models/Account.js';
import JournalEntry from '../models/JournalEntry.js';
import asyncHandler from '../middlewares/asyncHandler.js';
import ErrorResponse from '../utils/errorResponse.js';
import { ensureChart, accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { postEntry, subledgerStatement, accountBalance } from '../utils/ledger.js';
import { toPaisa, fromPaisa } from '../utils/money.js';
import { getNextSequence } from '../utils/sequence.js';
import { resolveMoney } from '../utils/moneyAccounts.js';
import { ACCOUNT_TYPES, JOURNAL_SOURCES } from '../utils/constants.js';

/** A validated, positive paisa amount, or an ErrorResponse-throwing reject. */
const amountPaisa = raw => {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0)
    throw new ErrorResponse('Enter an amount greater than zero', 400);
  return toPaisa(value);
};

/** A partner's capital = the credit balance of their equity account (rupees). */
const capitalOf = async (business, accountId) =>
  fromPaisa(-(await accountBalance(business, accountId)));

/**
 * A partner's running balance with the business (rupees): positive = business
 * money they're holding, negative = what the business owes them.
 */
const currentOf = async partner =>
  partner.currentAccount
    ? fromPaisa(await accountBalance(partner.business, partner.currentAccount))
    : 0;

/**
 * The list's lean projection. Everything getPartners derives from must be in it:
 * a missing account id reads as a zero balance rather than an error.
 */
export const PARTNER_LIST_FIELDS =
  'name sharePercent isActive capitalAccount currentAccount business createdAt updatedAt';

/**
 * @desc   List partners with their capital balances.
 * @route  GET /api/v1/partners  (partners:read — scoped)
 */
export const getPartners = asyncHandler(async (req, res) => {
  const result = res.advancedResults;
  const data = await Promise.all(
    result.data.map(async p => ({
      ...p.toObject(),
      capital: await capitalOf(p.business, p.capitalAccount),
      current: await currentOf(p)
    }))
  );
  res.status(200).json({ ...result, data });
});

/**
 * @desc   One partner with capital balance and a statement (contributions,
 *         drawings and profit share, oldest first).
 * @route  GET /api/v1/partners/:id  (partners:read — scoped)
 */
export const getPartner = asyncHandler(async (req, res) => {
  const partner = req.resource;
  const { rows } = await subledgerStatement(partner.business, 'account', partner.capitalAccount);
  res.status(200).json({
    success: true,
    data: {
      ...partner.toObject(),
      capital: await capitalOf(partner.business, partner.capitalAccount),
      current: await currentOf(partner),
      // Equity is credit-normal, so a credit grows capital — present the running
      // balance from the partner's side (positive = capital in the business).
      rows: rows.map(r => ({
        entry: r.entry,
        date: r.date,
        memo: r.memo,
        contribution: fromPaisa(r.creditPaisa),
        withdrawal: fromPaisa(r.debitPaisa),
        capital: fromPaisa(-r.balancePaisa)
      }))
    }
  });
});

/**
 * @desc   Add a partner — creates their dedicated equity (capital) account so
 *         their stake sits on its own in the balance sheet's Equity section.
 * @route  POST /api/v1/partners  (partners:create — scoped)
 */
export const createPartner = asyncHandler(async (req, res, next) => {
  const { business, name } = req.body;
  if (!business) return next(new ErrorResponse('Please select a business', 400));
  if (!name || !String(name).trim()) return next(new ErrorResponse('Please add a name', 400));
  await ensureChart(business);

  const seq = await getNextSequence('partnerCapital');
  const account = await Account.create({
    business,
    code: `32${String(seq).padStart(2, '0')}`,
    name: `${String(name).trim()} — Capital`,
    type: ACCOUNT_TYPES.EQUITY,
    isSystem: true,
    createdBy: req.user.id
  });

  const partner = await Partner.create({
    business,
    name: String(name).trim(),
    sharePercent: Number(req.body.sharePercent) || 0,
    phone: req.body.phone,
    note: req.body.note,
    isActive: req.body.isActive !== false,
    capitalAccount: account._id,
    createdBy: req.user.id
  });

  res.status(201).json({ success: true, data: partner });
});

/**
 * @desc   Edit a partner (name, share %, contact, active). Keeps the capital
 *         account's name in step with a rename.
 * @route  PUT /api/v1/partners/:id  (partners:update — scoped)
 */
export const updatePartner = asyncHandler(async (req, res) => {
  const partner = req.resource;
  if (req.body.name != null) {
    partner.name = String(req.body.name).trim();
    await Account.findByIdAndUpdate(partner.capitalAccount, { name: `${partner.name} — Capital` });
  }
  if (req.body.sharePercent != null) partner.sharePercent = Number(req.body.sharePercent) || 0;
  if (req.body.phone != null) partner.phone = req.body.phone;
  if (req.body.note != null) partner.note = req.body.note;
  if (req.body.isActive != null) partner.isActive = req.body.isActive;
  partner.updatedBy = req.user.id;
  await partner.save();
  res.status(200).json({ success: true, data: partner });
});

/**
 * @desc   Delete a partner — only while their capital account has no history.
 *         Otherwise deactivate (their capital stays on the books).
 * @route  DELETE /api/v1/partners/:id  (partners:delete — scoped)
 */
export const deletePartner = asyncHandler(async (req, res, next) => {
  const partner = req.resource;
  const used = await JournalEntry.exists({
    business: partner.business,
    'lines.account': partner.capitalAccount
  });
  if (used) {
    return next(
      new ErrorResponse(
        'This partner has capital history and can not be deleted — deactivate instead.',
        400
      )
    );
  }
  await Account.findByIdAndDelete(partner.capitalAccount);
  await partner.deleteOne();
  res.status(200).json({ success: true, data: {} });
});

/**
 * Shared by invest/withdraw: move money against the partner's capital. The money
 * side is any money account — or the partner's OWN running account, which is
 * how their personal dealings settle into their stake:
 *   withdraw from their own account → they keep business money they collected
 *   invest from their own account   → what the business owes them becomes capital
 */
const postCapitalMove = async (
  partner,
  { amountRaw, method, account, invest, date, memo, user }
) => {
  const paisa = amountPaisa(amountRaw);
  await ensureChart(partner.business);
  const money = await resolveMoney(partner.business, { account, method }, user);
  const own = money.partner && String(money.partner) === String(partner._id);
  const lines = invest
    ? [
        { account: money.account, debitPaisa: paisa },
        { account: partner.capitalAccount, creditPaisa: paisa }
      ]
    : [
        { account: partner.capitalAccount, debitPaisa: paisa },
        { account: money.account, creditPaisa: paisa }
      ];
  const defaultMemo = own
    ? invest
      ? `Money owed to ${partner.name} made capital`
      : `${partner.name} kept business money`
    : `${invest ? 'Put money in' : 'Took money out'} — ${partner.name}`;
  return postEntry({
    business: partner.business,
    date,
    memo: memo || defaultMemo,
    source: { kind: JOURNAL_SOURCES.CAPITAL },
    lines,
    userId: user.id
  });
};

/**
 * @desc   Partner puts money in — raises their capital.
 * @route  POST /api/v1/partners/:id/invest  (partners:update — scoped)
 */
export const investPartner = asyncHandler(async (req, res) => {
  const partner = req.resource;
  await postCapitalMove(partner, {
    amountRaw: req.body.amount,
    method: req.body.method,
    account: req.body.account,
    date: req.body.date,
    memo: req.body.memo,
    invest: true,
    user: req.user
  });
  res.status(201).json({
    success: true,
    data: { capital: await capitalOf(partner.business, partner.capitalAccount) }
  });
});

/**
 * @desc   Partner takes money out (drawings) — lowers their capital.
 * @route  POST /api/v1/partners/:id/withdraw  (partners:update — scoped)
 */
export const withdrawPartner = asyncHandler(async (req, res) => {
  const partner = req.resource;
  await postCapitalMove(partner, {
    amountRaw: req.body.amount,
    method: req.body.method,
    account: req.body.account,
    date: req.body.date,
    memo: req.body.memo,
    invest: false,
    user: req.user
  });
  res.status(201).json({
    success: true,
    data: { capital: await capitalOf(partner.business, partner.capitalAccount) }
  });
});

/**
 * @desc   Distribute a profit amount to active partners by their share %. Moves
 *         accumulated profit (Retained Earnings) into each partner's capital —
 *         an allocation within equity, so total equity is unchanged. Active
 *         partners' shares must total 100%.
 * @route  POST /api/v1/partners/distribute  (partners:update — scoped)
 */
export const distributeProfit = asyncHandler(async (req, res, next) => {
  const { business } = req.body;
  if (!business) return next(new ErrorResponse('Please select a business', 400));
  const paisa = amountPaisa(req.body.amount);

  const partners = await Partner.find({ business, isActive: true });
  if (!partners.length) return next(new ErrorResponse('No active partners to distribute to', 400));
  const totalShare = partners.reduce((sum, p) => sum + (p.sharePercent || 0), 0);
  if (totalShare !== 100) {
    return next(
      new ErrorResponse(
        `Active partners' shares total ${totalShare}% — they must total 100% before you can distribute.`,
        400
      )
    );
  }

  await ensureChart(business);
  const lines = [
    { account: (await accountByCode(business, CODES.RETAINED_EARNINGS))._id, debitPaisa: paisa }
  ];
  // Split by share; the last partner takes the rounding remainder so it balances.
  let allocated = 0;
  partners.forEach((p, i) => {
    const share =
      i === partners.length - 1 ? paisa - allocated : Math.round((paisa * p.sharePercent) / 100);
    allocated += share;
    if (share > 0) lines.push({ account: p.capitalAccount, creditPaisa: share });
  });

  const entry = await postEntry({
    business,
    memo: 'Profit distribution',
    source: { kind: JOURNAL_SOURCES.CAPITAL },
    lines,
    userId: req.user.id
  });
  res.status(201).json({ success: true, data: entry });
});
