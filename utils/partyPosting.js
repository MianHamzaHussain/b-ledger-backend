import Order from '../models/Order.js';
import ErrorResponse from './errorResponse.js';
import { accountByCode, CODES } from './chartOfAccounts.js';
import { partyAccountBalance } from './ledger.js';
import { toPaisa, fromPaisa } from './money.js';
import {
  ACCOUNT_TYPES,
  JOURNAL_SOURCES,
  ORDER_STATUS,
  PARTY_TYPES,
  PAYMENT_STATUS,
  SALES_CHANNELS
} from './constants.js';

/**
 * The accounting behind "You gave" / "You got" on a party's page — the one
 * DigiKhata-style action that works for every kind of party. The user only says
 * which way the money (or goods, or work) moved; the party's TYPE decides which
 * account it lands on, so the books stay double-entry without the user ever
 * choosing one. Kept out of the controller so the mapping is auditable in one
 * place, and shared with the salary form so both book salary identically.
 */

/** Cash or bank, defaulting to cash. */
export const methodCode = method => (method === 'bank' ? CODES.BANK : CODES.CASH);

/**
 * Salary for one employee — accrued as owed, or paid. Paying first clears what
 * the employee is already owed; only the part above that is new salary expense,
 * so an accrual followed by a payment books the salary once and nets to zero.
 *
 *   accrue:  Dr Salaries                         Cr Salaries Payable [employee]
 *   pay:     Dr Salaries (new part + advance cut) Cr Salaries Payable [employee]
 *            Dr Salaries Payable [employee]      Cr Cash/Bank (whole payment)
 *
 * An advance (`advanceLines`) is a debit on the same Salaries Payable account —
 * salary paid ahead. `deductAdvancePaisa` cuts some of it from this salary: the
 * salary EXPENSE is the full amount (cash paid + advance cut), while only the
 * cash leaves the drawer, and the advance on the employee's account shrinks.
 *
 * The employee is tagged only on Salaries Payable — never on the expense — so a
 * paid employee never shows as owing the business. With no employee, a payment
 * is a plain Dr Salaries / Cr Cash.
 */
export const salaryLines = async (
  business,
  party,
  paisa,
  { onCredit, method, deductAdvancePaisa = 0 } = {}
) => {
  const salaries = await accountByCode(business, CODES.SALARIES);
  const payable = await accountByCode(business, CODES.SALARIES_PAYABLE);

  if (onCredit) {
    return [
      { account: salaries._id, debitPaisa: paisa },
      { account: payable._id, party, creditPaisa: paisa }
    ];
  }

  const money = await accountByCode(business, methodCode(method));
  if (!party) {
    return [
      { account: salaries._id, debitPaisa: paisa },
      { account: money._id, creditPaisa: paisa }
    ];
  }

  // One account, one balance: negative = we owe them salary, positive = they
  // hold an advance from us. It can't be both at once.
  const balance = await partyAccountBalance(business, payable._id, party);
  const owedPaisa = Math.max(0, -balance);
  const advancePaisa = Math.max(0, balance);
  if (deductAdvancePaisa > advancePaisa) {
    throw new ErrorResponse(
      `Only Rs ${fromPaisa(advancePaisa)} of advance is left to cut from salary`,
      400
    );
  }

  const newSalaryPaisa = paisa - Math.min(paisa, owedPaisa) + deductAdvancePaisa;
  return [
    ...(newSalaryPaisa > 0
      ? [
          { account: salaries._id, debitPaisa: newSalaryPaisa },
          { account: payable._id, party, creditPaisa: newSalaryPaisa }
        ]
      : []),
    { account: payable._id, party, debitPaisa: paisa },
    { account: money._id, creditPaisa: paisa }
  ];
};

/**
 * An advance to an employee — salary paid ahead, not an expense yet. It sits on
 * their Salaries Payable account as money they hold of ours, and comes back by
 * being cut from a later salary (`deductAdvancePaisa`) or netted off salary due.
 *
 *   Dr Salaries Payable [employee]   Cr Cash/Bank
 */
export const advanceLines = async (business, party, paisa, method) => {
  const payable = await accountByCode(business, CODES.SALARIES_PAYABLE);
  const money = await accountByCode(business, methodCode(method));
  return [
    { account: payable._id, party, debitPaisa: paisa },
    { account: money._id, creditPaisa: paisa }
  ];
};

/**
 * Money in or out against a running account (a receivable or payable) tagged to
 * the party. `gave` moves money out and adds to what they owe us; `got` moves
 * money in and takes off it.
 */
const moneyLines = async (business, party, paisa, direction, accountCode, method) => {
  const ledger = (await accountByCode(business, accountCode))._id;
  const money = (await accountByCode(business, methodCode(method)))._id;
  return direction === 'gave'
    ? [
        { account: ledger, party, debitPaisa: paisa },
        { account: money, creditPaisa: paisa }
      ]
    : [
        { account: money, debitPaisa: paisa },
        { account: ledger, party, creditPaisa: paisa }
      ];
};

/**
 * Build the entry for "You gave" / "You got" on a party. Returns the balanced
 * lines, a plain-words memo and the journal source. Throws a 400 for anything
 * the party type can't support.
 *
 *   supplier   gave → pay them down            got → their bill (an expense, owed)
 *   reseller   gave → refund / credit given    got → their payment
 *   customer   gave → refund / credit given    got → their payment
 *   employee   gave → salary paid (clears owed first; can cut an advance),
 *                     or an advance (purpose: 'advance')     got → salary due
 *   lender     gave → loan repaid (principal)  got → loan taken
 *   courier    — handled by settleCourier (a lump-sum payment), not here
 */
export const partyTransactionLines = async (
  party,
  direction,
  paisa,
  { method, category, purpose, deductAdvancePaisa } = {}
) => {
  const business = party.business;
  const id = party._id;
  const name = party.name;

  switch (party.type) {
    case PARTY_TYPES.SUPPLIER: {
      if (direction === 'gave') {
        return {
          lines: await moneyLines(business, id, paisa, 'gave', CODES.ACCOUNTS_PAYABLE, method),
          memo: `Paid ${name}`,
          source: JOURNAL_SOURCES.PAYMENT
        };
      }
      // A bill: the supplier sold us something on credit. What it was for decides
      // which expense it is — without that, profit can't be right.
      if (!category) throw new ErrorResponse('Choose what this bill was for', 400);
      const expense = await accountByCode(business, category);
      if (expense.type !== ACCOUNT_TYPES.EXPENSE) {
        throw new ErrorResponse('That is not an expense category', 400);
      }
      const payable = await accountByCode(business, CODES.ACCOUNTS_PAYABLE);
      return {
        lines: [
          { account: expense._id, debitPaisa: paisa },
          { account: payable._id, party: id, creditPaisa: paisa }
        ],
        memo: `${expense.name} — bill from ${name}`,
        source: JOURNAL_SOURCES.EXPENSE
      };
    }

    case PARTY_TYPES.RESELLER:
    case PARTY_TYPES.CUSTOMER:
      return {
        lines: await moneyLines(business, id, paisa, direction, CODES.ACCOUNTS_RECEIVABLE, method),
        memo: direction === 'gave' ? `Given to ${name}` : `Received from ${name}`,
        source: JOURNAL_SOURCES.PAYMENT
      };

    case PARTY_TYPES.EMPLOYEE:
      // An advance is money they hold of ours until a later salary absorbs it.
      if (direction === 'gave' && purpose === 'advance') {
        return {
          lines: await advanceLines(business, id, paisa, method),
          memo: `Advance — ${name}`,
          source: JOURNAL_SOURCES.SALARY
        };
      }
      return {
        lines: await salaryLines(business, id, paisa, {
          onCredit: direction === 'got',
          method,
          deductAdvancePaisa
        }),
        memo: direction === 'gave' ? `Salary paid — ${name}` : `Salary due — ${name}`,
        source: JOURNAL_SOURCES.SALARY
      };

    case PARTY_TYPES.LENDER: {
      if (direction === 'gave') {
        // Only principal here; an installment with interest goes through the
        // loan form, which splits the interest out as a cost.
        const loan = await accountByCode(business, CODES.LOAN_PAYABLE);
        const owedPaisa = Math.max(0, -(await partyAccountBalance(business, loan._id, id)));
        if (paisa > owedPaisa) {
          throw new ErrorResponse(
            `That is more than the Rs ${fromPaisa(owedPaisa)} still owed on this loan`,
            400
          );
        }
      }
      return {
        lines: await moneyLines(business, id, paisa, direction, CODES.LOAN_PAYABLE, method),
        memo: direction === 'gave' ? `Loan repaid — ${name}` : `Loan from ${name}`,
        source: JOURNAL_SOURCES.LOAN
      };
    }

    default:
      // Couriers are handled before this (settleCourier) — only reachable if a
      // new party type is added without a mapping.
      throw new ErrorResponse('This kind of party can not be recorded here', 400);
  }
};

/**
 * Apply a credit customer's payment to their unpaid counter-sale orders, oldest
 * first, so each order's own "paid" state stays true. The payment entry itself
 * is already posted against the customer — this only records how much of each
 * order it covered (`paidPaisa`) and marks fully covered orders paid, so a later
 * "Mark paid" on the order books only what is genuinely still owed.
 *
 * Standalone DB (no transactions): each order is its own conditional update, so
 * a partial failure leaves already-applied orders correct rather than doubled.
 */
export const allocateCustomerPayment = async (business, customerParty, paisa) => {
  const orders = await Order.find({
    business,
    customerParty,
    source: SALES_CHANNELS.WALK_IN,
    status: ORDER_STATUS.DELIVERED,
    paymentStatus: PAYMENT_STATUS.UNPAID
  })
    .sort({ createdAt: 1 })
    .select('codAmount paidPaisa');

  let left = paisa;
  for (const order of orders) {
    if (left <= 0) break;
    const paidPaisa = order.paidPaisa || 0;
    const applied = Math.min(left, toPaisa(order.codAmount) - paidPaisa);
    if (applied <= 0) continue;
    const fullyPaid = paidPaisa + applied >= toPaisa(order.codAmount);
    await Order.updateOne(
      // Only if no other payment moved it meanwhile (null also matches unset).
      { _id: order._id, paidPaisa: order.paidPaisa ?? null },
      {
        $set: {
          paidPaisa: paidPaisa + applied,
          ...(fullyPaid ? { paymentStatus: PAYMENT_STATUS.PAID } : {})
        }
      }
    );
    left -= applied;
  }
};
