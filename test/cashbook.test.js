import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  connect,
  clear,
  disconnect,
  makeBusiness,
  makeParty,
  runHandler,
  oid,
  userId
} from './helpers/db.js';
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { postEntry } from '../utils/ledger.js';
import { getCashbook, getMoneySummary } from '../controllers/financeController.js';
import { toPaisa } from '../utils/money.js';

/**
 * The cash book is the Cash (or Bank) ledger read as money in / money out, with
 * the day's opening and closing — so it always agrees with the books.
 */

before(connect);
after(disconnect);
afterEach(clear);

const acc = async (biz, code) => (await accountByCode(biz._id, code))._id;

/** Post a two-line entry on a given day. */
const post = async (biz, date, memo, debit, credit, rupees, party) =>
  postEntry({
    business: biz._id,
    date: new Date(date),
    memo,
    lines: [
      { account: await acc(biz, debit), debitPaisa: toPaisa(rupees), party },
      { account: await acc(biz, credit), creditPaisa: toPaisa(rupees) }
    ],
    userId
  });

/** Sep 1: owner puts 10,000 cash + 5,000 bank in. Sep 2: rent 2,000 cash; supplier paid 3,000 by bank. */
async function setup() {
  const biz = await makeBusiness();
  const supplier = await makeParty(biz._id, 'supplier', { name: 'Master Tailor' });
  await post(
    biz,
    '2026-09-01T10:00:00Z',
    'Owner investment',
    CODES.CASH,
    CODES.OWNERS_CAPITAL,
    10000
  );
  await post(
    biz,
    '2026-09-01T11:00:00Z',
    'Owner investment',
    CODES.BANK,
    CODES.OWNERS_CAPITAL,
    5000
  );
  await post(biz, '2026-09-02T09:00:00Z', 'Rent', CODES.RENT, CODES.CASH, 2000);
  await post(
    biz,
    '2026-09-02T12:00:00Z',
    'Paid Master Tailor',
    CODES.ACCOUNTS_PAYABLE,
    CODES.BANK,
    3000,
    supplier._id
  );
  return biz;
}

const day = { from: '2026-09-02T00:00:00Z', to: '2026-09-02T23:59:59.999Z' };
const book = (biz, query) =>
  runHandler(getCashbook, { query: { business: String(biz._id), ...query }, accessFilter: {} });

test('a day of cash: opening from before, only that day, closing carried', async () => {
  const biz = await setup();
  const out = (await book(biz, day)).body.data;

  assert.equal(out.opening, 10000, 'opening is everything before the day');
  assert.equal(out.out, 2000);
  assert.equal(out.in, 0);
  assert.equal(out.closing, 8000);
  assert.equal(out.rows.length, 1, 'only that day, only cash');
  assert.equal(out.rows[0].memo, 'Rent');
  assert.equal(out.rows[0].balance, 8000);
});

test('the bank book names who the money went to', async () => {
  const biz = await setup();
  const out = (await book(biz, { ...day, account: 'bank' })).body.data;

  assert.equal(out.opening, 5000);
  assert.equal(out.closing, 2000);
  assert.equal(out.rows[0].party, 'Master Tailor');
  assert.equal(out.rows[0].out, 3000);
});

test('with no range it is the whole history', async () => {
  const biz = await setup();
  const out = (await book(biz, {})).body.data;
  assert.equal(out.opening, 0);
  assert.equal(out.in, 10000);
  assert.equal(out.closing, 8000);
});

test('summary: cash in hand, bank, to get and to give', async () => {
  const biz = await setup();
  const out = await runHandler(getMoneySummary, {
    query: { business: String(biz._id) },
    accessFilter: {}
  });
  assert.deepEqual(
    {
      cash: out.body.data.cash,
      bank: out.body.data.bank,
      receivable: out.body.data.receivable,
      payable: out.body.data.payable
    },
    // Paying a supplier we owed nothing leaves them owing us — an advance.
    { cash: 8000, bank: 2000, receivable: 3000, payable: 0 }
  );
});

test('rejects a bad account or date, and hides other businesses', async () => {
  const biz = await makeBusiness();
  await assert.rejects(book(biz, { account: 'wallet' }), /cash or bank/);
  await assert.rejects(book(biz, { from: 'yesterday-ish' }), /Invalid from/);
  await assert.rejects(
    runHandler(getCashbook, {
      query: { business: String(biz._id) },
      accessFilter: { business: { $in: [oid()] } }
    }),
    /not found/
  );
});
