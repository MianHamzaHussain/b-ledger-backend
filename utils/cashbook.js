import mongoose from 'mongoose';
import JournalEntry from '../models/JournalEntry.js';
import { ensureChart } from './chartOfAccounts.js';
import { accountBalance } from './ledger.js';
import { partyLedgerReport } from './reports.js';
import { pakistanDay } from './pakistanDay.js';
import { listMoneyAccounts } from './moneyAccounts.js';
import { MONEY_KINDS } from './constants.js';

const toId = value => new mongoose.Types.ObjectId(value);

/**
 * Cash-book order: by day, then by when each entry was recorded. A date picked in
 * a form is stored as midnight UTC (5 am in Pakistan), so sorting on the stored
 * time would put those entries first and show a time nobody entered.
 */
const byDayThenRecorded = (a, b) => {
  const dayA = pakistanDay(a.date);
  const dayB = pakistanDay(b.date);
  if (dayA !== dayB) return dayA < dayB ? -1 : 1;
  return a.createdAt - b.createdAt;
};

/**
 * The cash book (rokar) — what a DigiKhata user checks every morning: how much
 * cash was in the drawer when the day started, every rupee in and out, and what
 * should be there now. It is simply one money account's ledger (or a partner's
 * running account) for a date range, read as money in / money out instead of
 * debit / credit, so it can never disagree with the books. `accountId` is
 * already resolved and checked by the caller (resolveMoney).
 *
 * `from` / `to` are inclusive instants; the client sends its own local day
 * bounds, so "today" means today in Pakistan, not in UTC.
 */
export const cashbook = async (business, { accountId, from, to }) => {
  await ensureChart(business);
  const acc = { _id: toId(accountId) };

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
    .populate('lines.party', 'name')
    .lean();
  entries.sort(byDayThenRecorded);

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
      recordedAt: entry.createdAt,
      memo: entry.memo,
      party: withParty || null,
      inPaisa: net > 0 ? net : 0,
      outPaisa: net < 0 ? -net : 0,
      balancePaisa: running
    };
  });

  return {
    account: String(accountId),
    openingPaisa,
    inPaisa,
    outPaisa,
    closingPaisa: running,
    rows
  };
};

/**
 * The home screen's money: cash in hand, in banks, in wallets (each a total of
 * its money accounts), what you'll get and what you'll give (every party's net
 * balance, owed each way), and — for people who may read Partners — business
 * money partners are holding and what the business owes them.
 */
export const moneySummary = async (business, user) => {
  await ensureChart(business);
  const [{ accounts, partners }, parties] = await Promise.all([
    listMoneyAccounts(business, user),
    partyLedgerReport(business)
  ]);
  const totalOf = kind =>
    accounts.filter(a => a.kind === kind).reduce((sum, a) => sum + a.balancePaisa, 0);
  return {
    cashPaisa: totalOf(MONEY_KINDS.CASH),
    bankPaisa: totalOf(MONEY_KINDS.BANK),
    walletPaisa: totalOf(MONEY_KINDS.WALLET),
    receivablePaisa: parties.receivablePaisa,
    payablePaisa: parties.payablePaisa,
    partnersHoldingPaisa: partners.reduce((sum, p) => sum + Math.max(0, p.balancePaisa), 0),
    owedToPartnersPaisa: partners.reduce((sum, p) => sum + Math.max(0, -p.balancePaisa), 0)
  };
};
