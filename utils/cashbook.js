import mongoose from 'mongoose';
import JournalEntry from '../models/JournalEntry.js';
import { accountByCode, ensureChart, CODES } from './chartOfAccounts.js';
import { accountBalance } from './ledger.js';
import { partyLedgerReport } from './reports.js';

const toId = value => new mongoose.Types.ObjectId(value);

/**
 * The cash book (rokar) — what a DigiKhata user checks every morning: how much
 * cash was in the drawer when the day started, every rupee in and out, and what
 * should be there now. It is simply the Cash (or Bank) account's ledger for a
 * date range, read as money in / money out instead of debit / credit, so it can
 * never disagree with the books.
 *
 * `from` / `to` are inclusive instants; the client sends its own local day
 * bounds, so "today" means today in Pakistan, not in UTC.
 */
export const cashbook = async (business, { account = 'cash', from, to }) => {
  await ensureChart(business);
  const code = account === 'bank' ? CODES.BANK : CODES.CASH;
  const acc = await accountByCode(business, code);

  // Opening = everything posted before the range starts.
  const openingPaisa = from
    ? await accountBalance(business, acc._id, { asOf: new Date(from.getTime() - 1) })
    : 0;

  const dateMatch = {};
  if (from) dateMatch.$gte = from;
  if (to) dateMatch.$lte = to;
  const entries = await JournalEntry.find({
    business: toId(business),
    'lines.account': acc._id,
    ...(from || to ? { date: dateMatch } : {})
  })
    .sort({ date: 1, createdAt: 1 })
    .populate('lines.party', 'name')
    .lean();

  let running = openingPaisa;
  let inPaisa = 0;
  let outPaisa = 0;
  const rows = entries.map(entry => {
    // Net movement on this account within the entry (an entry can touch it twice).
    let net = 0;
    for (const line of entry.lines) {
      if (String(line.account) === String(acc._id)) {
        net += (line.debitPaisa || 0) - (line.creditPaisa || 0);
      }
    }
    running += net;
    if (net > 0) inPaisa += net;
    else outPaisa -= net;
    // Who it was with — the first party named on the entry, if any.
    const withParty = entry.lines.find(l => l.party?.name)?.party?.name;
    return {
      entry: entry._id,
      date: entry.date,
      memo: entry.memo,
      party: withParty || null,
      inPaisa: net > 0 ? net : 0,
      outPaisa: net < 0 ? -net : 0,
      balancePaisa: running
    };
  });

  return { account, openingPaisa, inPaisa, outPaisa, closingPaisa: running, rows };
};

/**
 * The four numbers on the home screen: cash in hand, bank, what you'll get and
 * what you'll give. Cash and bank are their accounts' balances; the other two
 * are every party's net balance, owed each way.
 */
export const moneySummary = async business => {
  await ensureChart(business);
  const [cash, bank] = await Promise.all([
    accountByCode(business, CODES.CASH),
    accountByCode(business, CODES.BANK)
  ]);
  const [cashPaisa, bankPaisa, parties] = await Promise.all([
    accountBalance(business, cash._id),
    accountBalance(business, bank._id),
    partyLedgerReport(business)
  ]);
  return {
    cashPaisa,
    bankPaisa,
    receivablePaisa: parties.receivablePaisa,
    payablePaisa: parties.payablePaisa
  };
};
