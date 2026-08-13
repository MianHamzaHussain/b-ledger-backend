import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, makeBusiness, runHandler, userId } from './helpers/db.js';
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { postEntry, accountBalance, trialBalance } from '../utils/ledger.js';
import { closePeriod } from '../controllers/financeController.js';
import { toPaisa } from '../utils/money.js';

before(connect);
after(disconnect);
afterEach(clear);

const acc = (biz, code) => accountByCode(biz, code).then(a => a._id);

test('year-end close sweeps income/expense into retained earnings', async () => {
  const biz = await makeBusiness();

  // A sale (income 5000) and rent (expense 1200) → net profit 3800.
  await postEntry({
    business: biz._id,
    memo: 'sale',
    lines: [
      { account: await acc(biz._id, CODES.CASH), debitPaisa: toPaisa(5000) },
      { account: await acc(biz._id, CODES.SALES), creditPaisa: toPaisa(5000) }
    ],
    userId
  });
  await postEntry({
    business: biz._id,
    memo: 'rent',
    lines: [
      { account: await acc(biz._id, CODES.RENT), debitPaisa: toPaisa(1200) },
      { account: await acc(biz._id, CODES.CASH), creditPaisa: toPaisa(1200) }
    ],
    userId
  });

  const out = await runHandler(closePeriod, { body: { business: String(biz._id) } });
  assert.equal(out.body.data.netProfit, 3800, 'reports the net profit moved');

  // Income + expense accounts are zeroed…
  assert.equal(await accountBalance(biz._id, await acc(biz._id, CODES.SALES)), 0);
  assert.equal(await accountBalance(biz._id, await acc(biz._id, CODES.RENT)), 0);
  // …and the profit sits in Retained Earnings (a credit balance).
  assert.equal(
    -(await accountBalance(biz._id, await acc(biz._id, CODES.RETAINED_EARNINGS))),
    toPaisa(3800)
  );
  // The books still balance.
  assert.equal((await trialBalance(biz._id)).balanced, true);
});

test('closing with no P&L activity is rejected', async () => {
  const biz = await makeBusiness();
  await assert.rejects(
    runHandler(closePeriod, { body: { business: String(biz._id) } }),
    /Nothing to close/
  );
});
