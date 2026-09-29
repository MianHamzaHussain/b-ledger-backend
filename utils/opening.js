import ErrorResponse from './errorResponse.js';
import { accountByCode, ensureChart, CODES } from './chartOfAccounts.js';
import { postEntry } from './ledger.js';
import { JOURNAL_SOURCES, PARTY_TYPES } from './constants.js';

/**
 * Opening balances — what the business already had and owed the day it starts
 * on B Ledger. They were earned or spent before, so they must not move cash or
 * count in this period's profit: each posts against Opening balances (equity),
 * the one account whose job is to hold "how things stood when we started".
 *
 *   stock / material on the shelf   Dr Inventory | Raw materials   Cr Opening balances
 *   they owed us                    Dr <their account>             Cr Opening balances
 *   we owed them                    Dr Opening balances            Cr <their account>
 *
 * (Cash and bank balances go in as the owners' starting money — capital.)
 */

/** Each kind of person's running account — the one their Khata already uses. */
const PARTY_ACCOUNT = {
  [PARTY_TYPES.SUPPLIER]: CODES.ACCOUNTS_PAYABLE,
  [PARTY_TYPES.RESELLER]: CODES.ACCOUNTS_RECEIVABLE,
  [PARTY_TYPES.CUSTOMER]: CODES.ACCOUNTS_RECEIVABLE,
  [PARTY_TYPES.EMPLOYEE]: CODES.SALARIES_PAYABLE,
  [PARTY_TYPES.COURIER]: CODES.COD_RECEIVABLE,
  [PARTY_TYPES.LENDER]: CODES.LOAN_PAYABLE
};

/**
 * A person's balance from before: `owesUs` — they owed the business (a reseller's
 * unpaid goods, COD a courier still held, an advance a worker had); otherwise the
 * business owed them (a supplier's unpaid bill, salary due, a loan).
 */
export const recordPartyOpening = async (party, { owesUs, amountPaisa, date, userId }) => {
  const code = PARTY_ACCOUNT[party.type];
  if (!code) throw new ErrorResponse('This kind of person has no opening balance', 400);
  if (party.type === PARTY_TYPES.LENDER && owesUs) {
    throw new ErrorResponse('A lender’s opening balance is what you still owe them', 400);
  }
  await ensureChart(party.business);
  const own = (await accountByCode(party.business, code))._id;
  const opening = (await accountByCode(party.business, CODES.OPENING_BALANCES))._id;
  const label = owesUs ? `Opening — ${party.name} owed us` : `Opening — we owed ${party.name}`;
  const theirs = { account: own, party: party._id, label };
  return postEntry({
    business: party.business,
    date,
    memo: label,
    source: { kind: JOURNAL_SOURCES.OPENING, ref: String(party._id) },
    lines: owesUs
      ? [
          { ...theirs, debitPaisa: amountPaisa },
          { account: opening, label, creditPaisa: amountPaisa }
        ]
      : [
          { account: opening, label, debitPaisa: amountPaisa },
          { ...theirs, creditPaisa: amountPaisa }
        ],
    userId
  });
};
