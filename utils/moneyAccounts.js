import mongoose from 'mongoose';
import Account from '../models/Account.js';
import Partner from '../models/Partner.js';
import ErrorResponse from './errorResponse.js';
import { accountByCode, ensureChart, CODES } from './chartOfAccounts.js';
import { accountBalance } from './ledger.js';
import { userCan } from './permissions.js';
import { ACCOUNT_TYPES, MONEY_KINDS, PARTNER_MONEY_PREFIX } from './constants.js';

/**
 * Money accounts — every real place the business's money sits (the shop's cash,
 * each bank account, each JazzCash/Easypaisa number) — and partners' running
 * accounts, for money a partner collected or paid personally.
 *
 * Anything that moves money names WHERE with one value:
 *   • a money account's id               — "into Meezan", "from JazzCash 0300…"
 *   • `partner:<partnerId>`              — "Hamza received it" / "Hamza paid it"
 *   • legacy `method: 'cash' | 'bank'`   — the original Cash and Main bank
 * `resolveMoney` turns that into the ledger account, so each posting builds its
 * lines the same way whichever it is. Only people who may read Partners can
 * name a partner — staff move money in the business's own accounts only.
 */

/** Codes for owner-added money accounts: banks 1011–1049, wallets 1051–1099. */
const CODE_RANGE = {
  [MONEY_KINDS.BANK]: [1011, 1049],
  [MONEY_KINDS.WALLET]: [1051, 1099],
  [MONEY_KINDS.CASH]: [1001, 1009]
};

// Businesses whose original Cash / Bank have been marked as money accounts —
// charts seeded before money accounts existed lack the mark. Once per process.
const kindsChecked = new Set();

/** Mark the original Cash and Bank as money accounts (older charts lack it). */
const ensureMoneyKinds = async business => {
  const key = String(business);
  if (kindsChecked.has(key)) return;
  await ensureChart(business);
  await Account.updateOne(
    { business, code: CODES.CASH, moneyKind: { $exists: false } },
    { $set: { moneyKind: MONEY_KINDS.CASH } }
  );
  await Account.updateOne(
    { business, code: CODES.BANK, moneyKind: { $exists: false } },
    { $set: { moneyKind: MONEY_KINDS.BANK } }
  );
  kindsChecked.add(key);
};

/** A partner's running account, created the first time money moves through it. */
export const partnerCurrentAccount = async partner => {
  if (partner.currentAccount) return partner.currentAccount;
  const used = await Account.find({ business: partner.business, code: /^15\d\d$/ })
    .select('code')
    .lean();
  const taken = new Set(used.map(a => Number(a.code)));
  let code = 1501;
  while (taken.has(code) && code < 1599) code += 1;
  const account = await Account.create({
    business: partner.business,
    code: String(code),
    name: `${partner.name} — current account`,
    type: ACCOUNT_TYPES.ASSET,
    isSystem: true
  });
  partner.currentAccount = account._id;
  await Partner.updateOne({ _id: partner._id }, { $set: { currentAccount: account._id } });
  return account._id;
};

/**
 * Where money moved — `{ account, name, partner? }`. Throws 400 for anything that
 * isn't one of this business's active money accounts or partners, and 403 when
 * someone without Partners access names a partner.
 */
export const resolveMoney = async (business, { account, method } = {}, user) => {
  await ensureMoneyKinds(business);

  if (typeof account === 'string' && account.startsWith(PARTNER_MONEY_PREFIX)) {
    if (user && !userCan(user, 'partners', 'read')) {
      throw new ErrorResponse("You can't record money against a partner", 403);
    }
    const partnerId = account.slice(PARTNER_MONEY_PREFIX.length);
    const partner = mongoose.isValidObjectId(partnerId)
      ? await Partner.findOne({ _id: partnerId, business })
      : null;
    if (!partner) throw new ErrorResponse('That partner is not in this business', 400);
    return {
      account: await partnerCurrentAccount(partner),
      name: partner.name,
      partner: partner._id
    };
  }

  if (account) {
    const found = mongoose.isValidObjectId(account)
      ? await Account.findOne({ _id: account, business, moneyKind: { $exists: true } })
      : null;
    if (!found) throw new ErrorResponse('Choose one of this business’s money accounts', 400);
    if (!found.isActive) throw new ErrorResponse(`${found.name} is closed`, 400);
    return { account: found._id, name: found.name };
  }

  const fallback = await accountByCode(business, method === 'bank' ? CODES.BANK : CODES.CASH);
  return { account: fallback._id, name: fallback.name };
};

/**
 * The business's money accounts with balances (paisa), and — for people who may
 * read Partners — each active partner's running balance: positive = business
 * money they're holding, negative = what the business owes them.
 */
export const listMoneyAccounts = async (business, user, { includeClosed = false } = {}) => {
  await ensureMoneyKinds(business);
  const accounts = await Account.find({
    business,
    moneyKind: { $exists: true },
    ...(includeClosed ? {} : { isActive: true })
  })
    .sort({ code: 1 })
    .lean();

  const withBalance = await Promise.all(
    accounts.map(async a => ({
      _id: a._id,
      name: a.name,
      kind: a.moneyKind,
      number: a.number,
      code: a.code,
      isActive: a.isActive,
      balancePaisa: await accountBalance(business, a._id)
    }))
  );

  let partners = [];
  if (!user || userCan(user, 'partners', 'read')) {
    const list = await Partner.find({ business, isActive: true }).sort({ name: 1 }).lean();
    partners = await Promise.all(
      list.map(async p => ({
        _id: `${PARTNER_MONEY_PREFIX}${p._id}`,
        partner: p._id,
        name: p.name,
        balancePaisa: p.currentAccount ? await accountBalance(business, p.currentAccount) : 0
      }))
    );
  }

  return { accounts: withBalance, partners };
};

/** Add a money account — a bank or wallet (or a second cash box). */
export const createMoneyAccount = async (business, { name, kind, number }, userId) => {
  await ensureMoneyKinds(business);
  const [from, to] = CODE_RANGE[kind] ?? [];
  if (!from) throw new ErrorResponse('Choose cash, bank or wallet', 400);

  const used = await Account.find({ business }).select('code').lean();
  const taken = new Set(used.map(a => Number(a.code)));
  let code = from;
  while (taken.has(code) && code <= to) code += 1;
  if (code > to) throw new ErrorResponse('No room for another account of this kind', 400);

  return Account.create({
    business,
    code: String(code),
    name,
    type: ACCOUNT_TYPES.ASSET,
    moneyKind: kind,
    number,
    createdBy: userId
  });
};
