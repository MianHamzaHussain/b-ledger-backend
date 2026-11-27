import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, makeBusiness, runHandler, userId } from './helpers/db.js';
import Account from '../models/Account.js';
import JournalEntry from '../models/JournalEntry.js';
import financeRouter from '../routes/finance.js';
import { lockPeriod, unlockPeriod } from '../controllers/financeController.js';
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { accountBalance, latestLock, postEntry } from '../utils/ledger.js';
import { clearCityCache } from '../utils/couriers/booking.js';
import { importReceipt } from '../utils/courierReceipts.js';
import { admin, deliveredParcel, restoreFetch } from './helpers/courier.js';

/**
 * Locking the books: only with Accountant tools, through the END of a Pakistan day, never backwards — and a PostEx
 * receipt whose payout day falls in a locked week still goes in, on the first open day.
 */
before(connect);
after(disconnect);
afterEach(async () => {
  restoreFetch();
  clearCityCache();
  await clear();
});

const lock = (biz, periodEnd, user = { id: userId }) =>
  runHandler(lockPeriod, { user, body: { business: String(biz._id), periodEnd } });

const post = async (biz, date) =>
  postEntry({
    business: biz._id,
    date: new Date(date),
    memo: 'Rent',
    lines: [
      { account: (await accountByCode(biz._id, CODES.RENT))._id, debitPaisa: 100 },
      { account: (await accountByCode(biz._id, CODES.CASH))._id, creditPaisa: 100 }
    ],
    userId
  });

/** Run the first handler of a route (its `can()`) for a user, and report what it said. */
const gate = (method, user) => {
  const layer = financeRouter.stack.find(l => l.route?.path === '/period-lock');
  const first = layer.route.stack.find(l => l.method === method).handle;
  return new Promise(resolve => first({ user, method: method.toUpperCase() }, {}, resolve));
};
const holding = (resource, ...actions) => ({
  id: userId,
  permissionOverrides: [],
  assignedBusinesses: [],
  role: { fullAccess: false, permissions: [{ resource, actions, scope: 'all' }] }
});

test('locking needs Accountant tools; journal rights alone are not enough', async () => {
  const everyday = holding('journal', 'read', 'create', 'update', 'delete');
  assert.equal((await gate('post', everyday)).statusCode, 403);
  assert.equal((await gate('delete', everyday)).statusCode, 403);

  const accountant = holding('accounting', 'create', 'delete');
  assert.equal(await gate('post', accountant), undefined, 'lock allowed');
  assert.equal(await gate('delete', accountant), undefined, 'unlock allowed');
  assert.equal(
    await gate('post', { id: userId, role: { fullAccess: true } }),
    undefined,
    'an admin'
  );
});

test('a lock runs through the end of a Pakistan day, whichever instant was sent', async () => {
  const biz = await makeBusiness();
  const out = await lock(biz, '2026-11-30');
  assert.equal(out.body.data.periodEnd.toISOString(), '2026-11-30T18:59:59.999Z');

  const biz2 = await makeBusiness({ name: 'Other' });
  // 10:00 UTC on 30 Nov is 15:00 in Pakistan — the same day, so the same end of day.
  const mid = await lock(biz2, '2026-11-30T10:00:00.000Z');
  assert.equal(mid.body.data.periodEnd.toISOString(), '2026-11-30T18:59:59.999Z');
});

test('22:30 on the locked day (Pakistan) is refused, naming that day; midnight after it posts', async () => {
  const biz = await makeBusiness();
  await lock(biz, '2026-11-30');
  await assert.rejects(post(biz, '2026-11-30T17:30:00.000Z'), /locked through 2026-11-30/);
  await post(biz, '2026-11-30T19:00:00.000Z'); // 1 Dec 00:00 in Pakistan
  assert.equal(await JournalEntry.countDocuments({ business: biz._id }), 1);
});

test('a lock can not go backwards, and unlocking removes only the latest', async () => {
  const biz = await makeBusiness();
  await lock(biz, '2026-11-23');
  await lock(biz, '2026-11-30');
  await assert.rejects(lock(biz, '2026-11-25'), /already locked through 2026-11-30/);
  await assert.rejects(lock(biz, '2026-11-30'), /already locked/);

  const out = await runHandler(unlockPeriod, {
    user: { id: userId },
    query: { business: String(biz._id) },
    accessFilter: {}
  });
  assert.equal(out.body.data.periodEnd.toISOString(), '2026-11-23T18:59:59.999Z');
  assert.equal((await latestLock(biz._id)).toISOString(), '2026-11-23T18:59:59.999Z');
});

test('a PostEx receipt dated in a locked week still goes in, on the first open day, with the reason in its memo', async () => {
  const made = await deliveredParcel({ paid: false });
  await lock(made.biz, '2026-11-10');

  const receipt = {
    cprNumber: 'CPR-LOCKED',
    cprDate: '2026-11-04',
    merchant: null,
    totals: {
      netPaisa: 363100,
      codPaisa: 0,
      shippingPaisa: 0,
      gstPaisa: 0,
      deductionPaisa: 0,
      delivered: 1,
      returned: 0
    },
    rows: [
      {
        tracking: 'CX-1001',
        status: 'delivered',
        codPaisa: 400000,
        shippingPaisa: 18000,
        gstPaisa: 2900,
        deductionPaisa: 16000,
        netPaisa: 363100
      }
    ]
  };
  await importReceipt({ business: made.biz._id, courier: made.courier, receipt, userId: admin.id });

  const entry = await JournalEntry.findOne({
    business: made.biz._id,
    'source.kind': 'courier-receipt'
  });
  assert.equal(
    entry.date.toISOString(),
    '2026-11-10T19:00:00.000Z',
    'the start of 11 Nov in Pakistan'
  );
  assert.match(entry.memo, /paid 2026-11-04, books locked through 2026-11-10/);
  const wallet = await Account.findOne({ business: made.biz._id, courier: made.courier._id });
  assert.equal(
    await accountBalance(made.biz._id, wallet._id),
    363100,
    'the same wallet as an unlocked import'
  );
});

test('an unlocked receipt keeps its own day and its plain memo', async () => {
  const made = await deliveredParcel({ paid: false });
  const receipt = {
    cprNumber: 'CPR-OPEN',
    cprDate: '2026-11-04',
    merchant: null,
    totals: {
      netPaisa: 363100,
      codPaisa: 0,
      shippingPaisa: 0,
      gstPaisa: 0,
      deductionPaisa: 0,
      delivered: 1,
      returned: 0
    },
    rows: [
      {
        tracking: 'CX-1001',
        status: 'delivered',
        codPaisa: 400000,
        shippingPaisa: 18000,
        gstPaisa: 2900,
        deductionPaisa: 16000,
        netPaisa: 363100
      }
    ]
  };
  await importReceipt({ business: made.biz._id, courier: made.courier, receipt, userId: admin.id });
  const entry = await JournalEntry.findOne({
    business: made.biz._id,
    'source.kind': 'courier-receipt'
  });
  assert.doesNotMatch(entry.memo, /locked/);
  assert.equal(
    entry.date.toISOString().slice(0, 10),
    '2026-11-03',
    '4 Nov 00:00 Pakistan is 3 Nov in UTC'
  );
});
