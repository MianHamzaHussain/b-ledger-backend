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
import { postEntry, reverseEntry } from '../utils/ledger.js';
import { courierWalletFor } from '../utils/moneyAccounts.js';
import { getCashbookEntries } from '../controllers/financeController.js';
import { cashbookEntriesQuerySchema } from '../schemas/finance.js';
import { toPaisa } from '../utils/money.js';

/**
 * One page of a money account's cash book, newest first, with what the account held after each row. It is the same
 * ledger read as the day view, so the numbers must agree with it — and with the books — whatever the page.
 */
before(connect);
after(disconnect);
afterEach(clear);

const acc = async (biz, code) => (await accountByCode(biz._id, code))._id;

const post = async (biz, date, memo, debit, credit, rupees, party) =>
  postEntry({
    business: biz._id,
    date: new Date(date),
    memo,
    lines: [
      {
        account: typeof debit === 'string' ? await acc(biz, debit) : debit,
        debitPaisa: toPaisa(rupees),
        party
      },
      {
        account: typeof credit === 'string' ? await acc(biz, credit) : credit,
        creditPaisa: toPaisa(rupees)
      }
    ],
    userId
  });

/** Cash: +10,000 capital first, then 44 rent payments of 10, each later than the last. */
async function setup() {
  const biz = await makeBusiness();
  await post(
    biz,
    '2026-09-01T05:00:00Z',
    'Owner investment',
    CODES.CASH,
    CODES.OWNERS_CAPITAL,
    10000
  );
  for (let i = 1; i <= 44; i += 1) {
    const at = new Date(Date.UTC(2026, 8, 1, 6) + i * 6 * 3600 * 1000);
    await post(biz, at, `Rent ${i}`, CODES.RENT, CODES.CASH, 10);
  }
  return biz;
}

const page = (biz, query = {}) =>
  runHandler(getCashbookEntries, {
    query: cashbookEntriesQuerySchema.parse({
      business: String(biz._id),
      account: 'cash',
      ...query
    }),
    accessFilter: {}
  }).then(r => r.body);

test('45 entries: newest 20 first, then 20, then 5, with the total and the way on', async () => {
  const biz = await setup();
  const one = await page(biz);
  assert.equal(one.total, 45);
  assert.equal(one.count, 20);
  assert.equal(one.data[0].memo, 'Rent 44', 'newest first');
  assert.deepEqual(one.pagination.next, { page: 2, limit: 20 });

  const three = await page(biz, { page: 3 });
  assert.equal(three.count, 5);
  assert.equal(three.data.at(-1).memo, 'Owner investment', 'oldest last');
  assert.equal(three.pagination.next, undefined);
  assert.deepEqual(three.pagination.prev, { page: 2, limit: 20 });
});

test('the balance after each row chains from the balance now back to the first entry, across pages', async () => {
  const biz = await setup();
  const all = [];
  for (const p of [1, 2, 3]) all.push(...(await page(biz, { page: p })).data);

  const now = (await page(biz)).summary.balanceNowPaisa;
  assert.equal(now, toPaisa(10000 - 440));
  assert.equal(all[0].balanceAfterPaisa, now, 'the newest row ends at the balance now');
  for (let i = 1; i < all.length; i += 1) {
    assert.equal(
      all[i].balanceAfterPaisa,
      all[i - 1].balanceAfterPaisa + all[i - 1].outPaisa - all[i - 1].inPaisa,
      `row ${i} follows row ${i - 1}`
    );
  }
  assert.equal(all.at(-1).balanceAfterPaisa, toPaisa(10000), 'the oldest ends at what it put in');
});

test('a date range gives its own in, out, opening and closing — and only its rows', async () => {
  const biz = await setup();
  // 2 Sep 2026 in Pakistan: Sep 1 19:00Z → Sep 2 18:59:59.999Z. Entries at 6h steps from Sep 1 06:00Z.
  const from = '2026-09-01T19:00:00.000Z';
  const to = '2026-09-02T18:59:59.999Z';
  const r = await page(biz, { from, to });
  assert.equal(
    r.summary.openingPaisa,
    toPaisa(10000 - 10 * 2),
    '2 rents (12:00 and 18:00Z) before the range'
  );
  assert.equal(r.summary.inPaisa, 0);
  assert.equal(r.summary.outPaisa, toPaisa(10 * r.total));
  assert.equal(r.summary.closingPaisa, r.summary.openingPaisa - r.summary.outPaisa);
  assert.equal(r.total, 4, 'rents at 00:00, 06:00, 12:00 and 18:00Z fall inside the Pakistan day');
  assert.equal(r.data[0].balanceAfterPaisa, r.summary.closingPaisa);
  for (const row of r.data) {
    assert.ok(new Date(row.date) >= new Date(from) && new Date(row.date) <= new Date(to));
  }
});

test('a row names the person, and a reversed entry and its reversal are marked', async () => {
  const biz = await makeBusiness();
  const supplier = await makeParty(biz._id, 'supplier', { name: 'Master Tailor' });
  const paid = await post(
    biz,
    '2026-09-02T09:00:00Z',
    'Paid',
    CODES.ACCOUNTS_PAYABLE,
    CODES.CASH,
    500,
    supplier._id
  );
  await reverseEntry(paid._id, { userId });
  const r = await page(biz);
  const original = r.data.find(x => x.entryId.equals(paid._id));
  assert.equal(original.party, 'Master Tailor');
  assert.equal(original.reversed, true);
  assert.equal(r.data.filter(x => x.isReversal).length, 1);
  assert.equal(r.summary.balanceNowPaisa, 0);
});

test('a bank account by id and the PostEx wallet can be read', async () => {
  const biz = await makeBusiness();
  const courier = await makeParty(biz._id, 'courier', { integration: { provider: 'postex' } });
  const wallet = await courierWalletFor(biz._id, courier, userId);
  await post(biz, '2026-09-02T09:00:00Z', 'PostEx payout', wallet._id, CODES.COD_RECEIVABLE, 1234);
  const r = await page(biz, { account: String(wallet._id) });
  assert.equal(r.total, 1);
  assert.equal(r.data[0].inPaisa, toPaisa(1234));
  assert.equal(r.summary.balanceNowPaisa, toPaisa(1234));
});

test('another business is not found, and a bad account or limit is refused', async () => {
  const biz = await makeBusiness();
  await assert.rejects(
    runHandler(getCashbookEntries, {
      query: cashbookEntriesQuerySchema.parse({ business: String(biz._id) }),
      accessFilter: { business: { $in: [oid()] } }
    }),
    /not found/
  );
  assert.throws(() =>
    cashbookEntriesQuerySchema.parse({ business: String(biz._id), account: 'wallet' })
  );
  assert.throws(() => cashbookEntriesQuerySchema.parse({ business: String(biz._id), limit: 51 }));
  assert.equal(cashbookEntriesQuerySchema.parse({ business: String(biz._id) }).limit, 20);
});
