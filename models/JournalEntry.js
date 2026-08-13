import mongoose from 'mongoose';
import { JOURNAL_SOURCES } from '../utils/constants.js';

/**
 * One posting line. It hits exactly one account, optionally tagged with the
 * party / product / batch it concerns (the subsidiary-ledger dimensions). A line
 * is a debit OR a credit, never both — enforced on the parent.
 */
const LineSchema = new mongoose.Schema(
  {
    account: { type: mongoose.Schema.ObjectId, ref: 'Account', required: true },
    // `party` is the one contact dimension — supplier, reseller, employee, or
    // courier. COD-receivable tags the courier party, so it reconciles per courier.
    party: { type: mongoose.Schema.ObjectId, ref: 'Party' },
    product: { type: mongoose.Schema.ObjectId, ref: 'Product' },
    batch: { type: mongoose.Schema.ObjectId, ref: 'ProductionBatch' },
    /** Line description — e.g. a production cost's name ("Cloth", "Tailor") so the
     *  ledger shows what a batch's inventory debit was made of. */
    label: { type: String, trim: true, maxlength: [80, 'Label too long'] },
    debitPaisa: { type: Number, default: 0, min: [0, 'Debit can not be negative'] },
    creditPaisa: { type: Number, default: 0, min: [0, 'Credit can not be negative'] }
  },
  { _id: false }
);

/**
 * A balanced journal entry — the atom of the whole accounting module.
 *
 * Both sides of every transaction live in this ONE document's `lines[]`, so
 * posting is a single atomic write. That is how the module stays correct on a
 * standalone MongoDB with no transactions (backend CLAUDE.md §5.3.2): there is
 * no moment where one half is saved and the other isn't.
 *
 * History is append-only. A mistake is fixed by posting a reversing entry
 * (`reversalOf`), never by editing a past one — that's what keeps a period's
 * numbers trustworthy after the fact.
 */
const JournalEntrySchema = new mongoose.Schema(
  {
    business: {
      type: mongoose.Schema.ObjectId,
      ref: 'Business',
      required: [true, 'Please select a business']
    },
    date: { type: Date, default: Date.now },
    memo: {
      type: String,
      trim: true,
      maxlength: [200, 'Memo can not be more than 200 characters']
    },
    /** What created this entry, and the id of that source doc — for trace + idempotency. */
    source: {
      kind: { type: String, enum: Object.values(JOURNAL_SOURCES), default: JOURNAL_SOURCES.MANUAL },
      ref: { type: String }
    },
    lines: { type: [LineSchema], default: [] },
    reversalOf: { type: mongoose.Schema.ObjectId, ref: 'JournalEntry' },
    createdBy: { type: mongoose.Schema.ObjectId, ref: 'User', required: true },
    updatedBy: { type: mongoose.Schema.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

JournalEntrySchema.index({ business: 1, date: -1 });
JournalEntrySchema.index({ business: 1, 'lines.account': 1 });
JournalEntrySchema.index({ business: 1, 'lines.party': 1 });
JournalEntrySchema.index({ 'source.kind': 1, 'source.ref': 1 });

/**
 * The invariant that makes the books trustworthy: at least two lines, each a
 * debit XOR a credit, and total debits === total credits. If this ever fails,
 * the entry is rejected rather than silently unbalancing the ledger.
 */
JournalEntrySchema.pre('validate', function () {
  const lines = this.lines || [];
  if (lines.length < 2) {
    this.invalidate('lines', 'A journal entry needs at least two lines');
    return;
  }

  let debit = 0;
  let credit = 0;
  for (const line of lines) {
    const d = line.debitPaisa || 0;
    const c = line.creditPaisa || 0;
    if (d > 0 && c > 0) {
      this.invalidate('lines', 'A line is either a debit or a credit, not both');
      return;
    }
    if (d === 0 && c === 0) {
      this.invalidate('lines', 'Each line must carry an amount');
      return;
    }
    debit += d;
    credit += c;
  }

  if (debit !== credit) {
    this.invalidate('lines', `Entry is out of balance: debits ${debit} ≠ credits ${credit}`);
  }
});

export default mongoose.model('JournalEntry', JournalEntrySchema);
