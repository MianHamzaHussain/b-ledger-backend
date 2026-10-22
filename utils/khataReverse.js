import JournalEntry from '../models/JournalEntry.js';
import ErrorResponse from './errorResponse.js';
import { accountByCode, CODES } from './chartOfAccounts.js';
import { partyAccountBalance, reverseEntry } from './ledger.js';
import { unallocateCustomerPayment } from './partyPosting.js';
import { JOURNAL_SOURCES, PARTY_TYPES } from './constants.js';

/**
 * Reversing from a person's Khata. Only what the Khata itself created is
 * reversible here — a payment, a bill, a salary, a loan, an opening balance.
 * Everything else belongs to a record (an order, an invoice, a material) that
 * must stay in step with the books, so it is undone there.
 */
export const KHATA_REVERSIBLE = new Set([
  JOURNAL_SOURCES.PAYMENT,
  JOURNAL_SOURCES.EXPENSE,
  JOURNAL_SOURCES.SALARY,
  JOURNAL_SOURCES.LOAN,
  JOURNAL_SOURCES.OPENING
]);

/** Where to undo an entry that can't be reversed from Khata. */
export const reverseMessage = kind => {
  switch (kind) {
    case JOURNAL_SOURCES.ORDER:
    case JOURNAL_SOURCES.ORDER_ADVANCE:
    case JOURNAL_SOURCES.ORDER_REFUND:
    case JOURNAL_SOURCES.CUSTOM_COST:
      return 'Undo this on the order';
    case JOURNAL_SOURCES.COURIER_INVOICE:
      return 'Undo this by reversing the courier invoice (Accountant tools)';
    case JOURNAL_SOURCES.MATERIAL:
      return 'Undo this on the material (Raw materials)';
    case JOURNAL_SOURCES.GOODS_RECEIPT:
      return 'Undo this on the goods receipt';
    case JOURNAL_SOURCES.BATCH:
      return 'This came from a production batch';
    case JOURNAL_SOURCES.CONSIGNMENT:
      return 'Undo this on the Sale or Return';
    default:
      return 'Undo this in Accountant tools';
  }
};

/**
 * Reverse one of this person's Khata entries. Throws a 4xx naming the reason when
 * it can't be; otherwise posts the reversal and undoes any side effect — a credit
 * customer's payment comes back off their counter sales.
 */
export const reverseKhataEntry = async (party, entryId, userId) => {
  const entry = await JournalEntry.findOne({ _id: entryId, business: party.business });
  const line = entry?.lines.find(l => String(l.party) === String(party._id));
  if (!entry || !line) throw new ErrorResponse('Entry not found', 404);

  const kind = entry.source?.kind;
  if (!KHATA_REVERSIBLE.has(kind)) throw new ErrorResponse(reverseMessage(kind), 400);
  if (entry.reversalOf) {
    throw new ErrorResponse('A reversal entry can not itself be reversed', 400);
  }
  if (await JournalEntry.exists({ reversalOf: entry._id })) {
    throw new ErrorResponse('This entry has already been reversed', 400);
  }

  // A loan taken can't be undone while part of it is already repaid — the
  // repayments would then be owed against a loan that never existed.
  if (kind === JOURNAL_SOURCES.LOAN && party.type === PARTY_TYPES.LENDER && line.creditPaisa) {
    const loan = await accountByCode(party.business, CODES.LOAN_PAYABLE);
    const owedPaisa = -(await partyAccountBalance(party.business, loan._id, party._id));
    if (owedPaisa < line.creditPaisa) {
      throw new ErrorResponse(
        'Part of this loan is already repaid — reverse the repayments first',
        400
      );
    }
  }

  const reversal = await reverseEntry(entry._id, { userId });

  if (kind === JOURNAL_SOURCES.PAYMENT && party.type === PARTY_TYPES.CUSTOMER && line.creditPaisa) {
    await unallocateCustomerPayment(party.business, party._id, line.creditPaisa);
  }
  return reversal;
};
