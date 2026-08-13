import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, makeBusiness, userId } from './helpers/db.js';
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { postEntry, reverseEntry, trialBalance, accountBalance } from '../utils/ledger.js';
import { toPaisa } from '../utils/money.js';

before(connect);
after(disconnect);
afterEach(clear);

const acc = (biz, code) => accountByCode(biz, code).then(a => a._id);

test('a balanced entry posts and keeps the trial balance at zero', async () => {
  const biz = await makeBusiness();
  await postEntry({
    business: biz._id,
    memo: 'Cash sale',
    lines: [
      { account: await acc(biz._id, CODES.CASH), debitPaisa: toPaisa(1000) },
      { account: await acc(biz._id, CODES.SALES), creditPaisa: toPaisa(1000) }
    ],
    userId
  });
  const tb = await trialBalance(biz._id);
  assert.equal(tb.balanced, true);
  assert.equal(tb.totalPaisa, 0);
});

test('an UNBALANCED entry is rejected by the model', async () => {
  const biz = await makeBusiness();
  await assert.rejects(
    postEntry({
      business: biz._id,
      memo: 'lopsided',
      lines: [
        { account: await acc(biz._id, CODES.CASH), debitPaisa: toPaisa(1000) },
        { account: await acc(biz._id, CODES.SALES), creditPaisa: toPaisa(900) }
      ],
      userId
    }),
    /balanc/i
  );
});

test('reverseEntry mirrors the sides, preserves the label, and re-balances', async () => {
  const biz = await makeBusiness();
  const entry = await postEntry({
    business: biz._id,
    memo: 'Sale — order 0042',
    source: { kind: 'order', ref: 'x' },
    lines: [
      {
        account: await acc(biz._id, CODES.COD_RECEIVABLE),
        label: 'Order #0042 · TCS999',
        debitPaisa: toPaisa(1000)
      },
      { account: await acc(biz._id, CODES.SALES), creditPaisa: toPaisa(1000) }
    ],
    userId
  });

  const rev = await reverseEntry(entry._id, { userId, memo: 'Reversal' });
  const labelled = rev.lines.find(l => l.label);
  assert.equal(labelled.label, 'Order #0042 · TCS999', 'label carried onto the reversal');
  assert.equal(labelled.creditPaisa, toPaisa(1000), 'debit became a credit');

  const tb = await trialBalance(biz._id);
  assert.equal(tb.balanced, true);
  // Original + its mirror net the account back to zero.
  assert.equal(await accountBalance(biz._id, await acc(biz._id, CODES.COD_RECEIVABLE)), 0);
});
