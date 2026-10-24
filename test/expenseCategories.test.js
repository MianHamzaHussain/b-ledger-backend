import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, makeBusiness, runHandler, userId } from './helpers/db.js';
import Account from '../models/Account.js';
import JournalEntry from '../models/JournalEntry.js';
import Partner from '../models/Partner.js';
import { ensureChart, CODES } from '../utils/chartOfAccounts.js';
import { profitAndLoss } from '../utils/reports.js';
import { toPaisa } from '../utils/money.js';
import { recordExpense, recordCapital } from '../controllers/financeController.js';
import {
  createPartner,
  withdrawPartner,
  distributeProfit
} from '../controllers/partnerController.js';
import { expenseSchema, capitalSchema } from '../schemas/finance.js';

/**
 * Where money goes shows on the profit and loss: ads (Meta Ads on its own line), office
 * costs and salaries are business expenses and lower profit. What the owner takes for
 * home or personal spending is not a business cost — it stays out of profit and is shown
 * below it, so the business's real profit is not muddied by home life.
 */

before(connect);
after(disconnect);
afterEach(clear);

const admin = { id: userId, role: { fullAccess: true } };

const spend = (biz, category, amount) =>
  runHandler(recordExpense, {
    user: admin,
    body: expenseSchema.parse({
      business: String(biz._id),
      amount,
      category,
      method: 'cash'
    })
  });

const take = (biz, amount, extra = {}) =>
  runHandler(recordCapital, {
    user: admin,
    body: capitalSchema.parse({
      business: String(biz._id),
      amount,
      direction: 'drawings',
      method: 'cash',
      ...extra
    })
  });

const line = (pnl, code) => pnl.expense.find(r => r.code === code);

test('Meta Ads, other ads, office, salaries and rent each get their own expense line', async () => {
  const biz = await makeBusiness();
  await spend(biz, CODES.META_ADS, 5000);
  await spend(biz, CODES.OTHER_ADS, 1200);
  await spend(biz, CODES.OFFICE, 800);
  await spend(biz, CODES.SALARIES, 9000);
  await spend(biz, CODES.RENT, 4000);

  const pnl = await profitAndLoss(biz._id);
  assert.equal(line(pnl, CODES.META_ADS).amountPaisa, toPaisa(5000));
  assert.equal(line(pnl, CODES.META_ADS).name, 'Meta Ads (Facebook, Instagram)');
  assert.equal(line(pnl, CODES.OTHER_ADS).amountPaisa, toPaisa(1200));
  assert.equal(line(pnl, CODES.OFFICE).amountPaisa, toPaisa(800));
  assert.equal(line(pnl, CODES.SALARIES).amountPaisa, toPaisa(9000));
  assert.equal(pnl.expensePaisa, toPaisa(5000 + 1200 + 800 + 9000 + 4000));
  assert.equal(pnl.netProfitPaisa, -pnl.expensePaisa);
});

test('a business set up before these accounts existed gets them on first use', async () => {
  const biz = await makeBusiness();
  await ensureChart(biz._id);
  await Account.deleteMany({
    business: biz._id,
    code: { $in: [CODES.META_ADS, CODES.OTHER_ADS, CODES.OFFICE] }
  });

  await spend(biz, CODES.META_ADS, 700);
  const pnl = await profitAndLoss(biz._id);
  assert.equal(line(pnl, CODES.META_ADS).amountPaisa, toPaisa(700));
});

test('the money an owner takes for home stays out of profit and shows below it', async () => {
  const biz = await makeBusiness();
  await spend(biz, CODES.META_ADS, 5000);
  const before = await profitAndLoss(biz._id);

  await take(biz, 3000, { purpose: 'home' });
  const after = await profitAndLoss(biz._id);

  assert.equal(after.netProfitPaisa, before.netProfitPaisa, 'profit is unchanged');
  assert.equal(after.expensePaisa, before.expensePaisa);
  assert.equal(after.ownerTookPaisa, toPaisa(3000));
  assert.equal(after.leftInBusinessPaisa, after.netProfitPaisa - toPaisa(3000));
});

test('home and personal words land on the cash book; the default stays as it was', async () => {
  const biz = await makeBusiness();
  await take(biz, 100, { purpose: 'home' });
  await take(biz, 100, { purpose: 'personal' });
  await take(biz, 100);
  await take(biz, 100, { purpose: 'home', memo: 'Eid shopping' });

  const memos = (await JournalEntry.find({ business: biz._id }).sort({ createdAt: 1 })).map(
    e => e.memo
  );
  assert.deepEqual(memos, ['Home expense', 'Personal expense', 'Owner took money', 'Eid shopping']);
  assert.equal(
    capitalSchema.safeParse({ business: 'b', amount: 1, direction: 'drawings', purpose: 'x' })
      .success,
    false
  );
});

test('money a partner takes out counts too, and a profit share does not', async () => {
  const biz = await makeBusiness();
  const ali = (
    await runHandler(createPartner, {
      body: { business: String(biz._id), name: 'Ali', sharePercent: 100 }
    })
  ).body.data;

  await runHandler(withdrawPartner, {
    resource: await Partner.findById(ali._id),
    body: { amount: 2500, method: 'cash' }
  });
  await runHandler(distributeProfit, { body: { business: String(biz._id), amount: 1000 } });

  const pnl = await profitAndLoss(biz._id);
  assert.equal(pnl.ownerTookPaisa, toPaisa(2500), 'only the withdrawal, not the profit share');
});

test('the period filter applies to what the owner took, like everything else', async () => {
  const biz = await makeBusiness();
  await take(biz, 1000, { date: '2026-09-10' });
  await take(biz, 2000, { date: '2026-10-10' });

  const october = await profitAndLoss(biz._id, { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(october.ownerTookPaisa, toPaisa(2000));
  const all = await profitAndLoss(biz._id);
  assert.equal(all.ownerTookPaisa, toPaisa(3000));
});
