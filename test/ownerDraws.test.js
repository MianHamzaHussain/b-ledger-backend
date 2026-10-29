import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, makeBusiness, runHandler, userId } from './helpers/db.js';
import JournalEntry from '../models/JournalEntry.js';
import Partner from '../models/Partner.js';
import {
  recordCapital,
  recordExpense,
  getOwnerDraws,
  reverseJournalEntry
} from '../controllers/financeController.js';
import {
  createPartner,
  withdrawPartner,
  updatePartner,
  getPartner
} from '../controllers/partnerController.js';
import { ownerDrawsByMonth, partnerThisMonth, profitAndLoss } from '../utils/reports.js';
import { capitalSchema } from '../schemas/finance.js';
import { capitalMoveSchema, partnerUpdateSchema } from '../schemas/partners.js';

/**
 * What the owners took for home and personal use, month by month (R9-12). It is the owner's own money, so it
 * never lowers profit; the report shows it beside each month's profit and what was left in the business.
 */
before(connect);
after(disconnect);
afterEach(clear);

const admin = { id: userId, role: { fullAccess: true } };
const NOW = new Date('2026-10-20T07:00:00Z'); // 12:00 in Pakistan

const addPartner = (biz, name) =>
  runHandler(createPartner, { body: { business: String(biz._id), name, sharePercent: 50 } }).then(
    r => r.body.data
  );

/** A withdrawal by `partner`, dated `date` (a Pakistan day), for `purpose`. */
const take = (partner, amount, date, purpose, memo) =>
  runHandler(withdrawPartner, {
    user: admin,
    resource: partner,
    body: capitalMoveSchema.parse({ amount, method: 'cash', date, purpose, memo })
  });

const months = (biz, extra = {}) => ownerDrawsByMonth(biz._id, { now: NOW, months: 3, ...extra });

test('a withdrawal keeps why it was taken; the report totals home, personal and other apart', async () => {
  const biz = await makeBusiness();
  const hamza = await addPartner(biz, 'Hamza');
  await take(hamza, 50000, '2026-10-05', 'home');
  await take(hamza, 20000, '2026-10-09', 'personal');
  await take(hamza, 5000, '2026-10-12'); // no purpose, no helpful memo

  const [oct] = await months(biz);
  assert.equal(oct.month, '2026-10');
  assert.equal(oct.tookPaisa, 75000 * 100);
  assert.deepEqual(oct.byPurpose, { home: 50000 * 100, personal: 20000 * 100, other: 5000 * 100 });
  assert.deepEqual(oct.byPartner, [{ name: 'Hamza', tookPaisa: 75000 * 100 }]);
});

test('older entries with no purpose are read from their memo', async () => {
  const biz = await makeBusiness();
  const hamza = await addPartner(biz, 'Hamza');
  await take(hamza, 1000, '2026-10-05', undefined, 'Home expense — Hamza');
  await take(hamza, 2000, '2026-10-06', undefined, 'Personal expense');
  const [oct] = await months(biz);
  assert.deepEqual(oct.byPurpose, { home: 1000 * 100, personal: 2000 * 100, other: 0 });
});

test('the months are Pakistan months: 11:30 pm on the 31st belongs to that month, not the next', async () => {
  const biz = await makeBusiness();
  const hamza = await addPartner(biz, 'Hamza');
  // 18:30 UTC on 31 Oct is 23:30 in Pakistan; a UTC month would call it October too, but 20:00 UTC
  // on 31 Oct is 01:00 on 1 Nov in Pakistan — that one is November's.
  await runHandler(withdrawPartner, {
    user: admin,
    resource: hamza,
    body: capitalMoveSchema.parse({
      amount: 100,
      method: 'cash',
      date: new Date('2026-10-31T18:30:00Z')
    })
  });
  await runHandler(withdrawPartner, {
    user: admin,
    resource: hamza,
    body: capitalMoveSchema.parse({
      amount: 300,
      method: 'cash',
      date: new Date('2026-10-31T20:00:00Z')
    })
  });
  const rows = await ownerDrawsByMonth(biz._id, {
    from: '2026-10-01',
    to: '2026-11-30',
    now: new Date('2026-11-20T07:00:00Z')
  });
  const byMonth = Object.fromEntries(rows.map(r => [r.month, r.tookPaisa]));
  assert.equal(byMonth['2026-10'], 100 * 100);
  assert.equal(byMonth['2026-11'], 300 * 100);
});

test('every month in the range is a row, newest first, empty months included', async () => {
  const biz = await makeBusiness();
  const hamza = await addPartner(biz, 'Hamza');
  await take(hamza, 1000, '2026-08-10', 'home');
  const rows = await months(biz);
  assert.deepEqual(
    rows.map(r => r.month),
    ['2026-10', '2026-09', '2026-08']
  );
  assert.equal(rows[1].tookPaisa, 0);
  assert.equal(rows[2].tookPaisa, 1000 * 100);
});

test('what the owner took never lowers profit; "left in the business" is profit minus it, per month', async () => {
  const biz = await makeBusiness();
  const hamza = await addPartner(biz, 'Hamza');
  // Put money in first so there is cash to spend, and take 20,000 for home.
  await runHandler(withdrawPartner, {
    user: admin,
    resource: hamza,
    body: capitalMoveSchema.parse({
      amount: 20000,
      method: 'cash',
      date: '2026-10-05',
      purpose: 'home'
    })
  });
  const [oct] = await months(biz);
  assert.equal(
    oct.netProfitPaisa,
    0,
    'no income or expense, so no profit — and the draw did not change it'
  );
  assert.equal(oct.leftInBusinessPaisa, -20000 * 100, 'taking more than was earned shows as minus');
  assert.equal((await profitAndLoss(biz._id)).netProfitPaisa, 0);
});

test('a drawing that was reversed does not count, and neither does its reversal', async () => {
  const biz = await makeBusiness();
  const hamza = await addPartner(biz, 'Hamza');
  await take(hamza, 8000, '2026-10-05', 'home');
  await take(hamza, 1000, '2026-10-06', 'home');
  const mistaken = await JournalEntry.findOne({ business: biz._id, memo: /Took money out/ }).sort({
    createdAt: 1
  });
  await runHandler(reverseJournalEntry, {
    user: admin,
    resource: mistaken,
    body: {}
  });

  const [oct] = await months(biz);
  assert.equal(oct.tookPaisa, 1000 * 100, 'only the entry that stands');
  assert.equal((await profitAndLoss(biz._id)).ownerTookPaisa, 1000 * 100, 'the P&L line agrees');
});

test('without partners the shared owner account is one "Owner" row', async () => {
  const biz = await makeBusiness();
  await runHandler(recordCapital, {
    user: admin,
    body: capitalSchema.parse({
      business: String(biz._id),
      amount: 4000,
      direction: 'drawings',
      purpose: 'home',
      method: 'cash',
      date: '2026-10-07'
    })
  });
  const [oct] = await months(biz);
  assert.deepEqual(oct.byPartner, [{ name: 'Owner', tookPaisa: 4000 * 100 }]);
  assert.equal(oct.byPurpose.home, 4000 * 100);
});

test('people who may not read partners see one Owner row, never the names', async () => {
  const biz = await makeBusiness();
  const hamza = await addPartner(biz, 'Hamza');
  const bilal = await addPartner(biz, 'Bilal');
  await take(hamza, 3000, '2026-10-05', 'home');
  await take(bilal, 2000, '2026-10-06', 'personal');

  const [oct] = await months(biz, { showPartners: false });
  assert.deepEqual(oct.byPartner, [{ name: 'Owner', tookPaisa: 5000 * 100 }]);
  const named = (await months(biz))[0].byPartner.map(p => p.name).sort();
  assert.deepEqual(named, ['Bilal', 'Hamza']);
});

test('the endpoint reads the business from the query and answers with the months', async () => {
  const biz = await makeBusiness();
  const hamza = await addPartner(biz, 'Hamza');
  await take(hamza, 1500, '2026-10-05', 'home');
  const { body } = await runHandler(getOwnerDraws, {
    user: admin,
    query: { business: String(biz._id), from: '2026-10-01', to: '2026-10-31' }
  });
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].tookPaisa, 1500 * 100);
});

test('the monthly allowance is set in rupees, kept in paisa, and cleared with 0', async () => {
  const biz = await makeBusiness();
  const hamza = await addPartner(biz, 'Hamza');
  const set = amount =>
    runHandler(updatePartner, {
      user: admin,
      resource: hamza,
      body: partnerUpdateSchema.parse({ monthlyAllowance: amount })
    });
  await set(100000);
  assert.equal((await Partner.findById(hamza._id)).monthlyAllowancePaisa, 100000 * 100);
  await set(0);
  assert.equal((await Partner.findById(hamza._id)).monthlyAllowancePaisa, undefined);
  assert.equal(partnerUpdateSchema.safeParse({ monthlyAllowance: -1 }).success, false);
});

test('"taken this month" counts only this partner, this Pakistan month, against the allowance', async () => {
  const biz = await makeBusiness();
  const hamza = await addPartner(biz, 'Hamza');
  const bilal = await addPartner(biz, 'Bilal');
  await runHandler(updatePartner, {
    user: admin,
    resource: hamza,
    body: partnerUpdateSchema.parse({ monthlyAllowance: 100000 })
  });
  await take(hamza, 30000, '2026-10-05', 'home');
  await take(hamza, 10000, '2026-09-28', 'home'); // last month
  await take(bilal, 99000, '2026-10-06', 'home'); // someone else

  const mine = await partnerThisMonth(await Partner.findById(hamza._id), NOW);
  assert.deepEqual(mine, {
    month: '2026-10',
    tookPaisa: 30000 * 100,
    allowancePaisa: 100000 * 100
  });

  const { body } = await runHandler(getPartner, { resource: await Partner.findById(bilal._id) });
  assert.equal(body.data.thisMonth.allowancePaisa, null, 'no allowance set: no limit shown');
});

test('a shop expense is not an owner draw', async () => {
  const biz = await makeBusiness();
  await runHandler(recordExpense, {
    user: admin,
    body: { business: String(biz._id), category: 'other', amount: 500, method: 'cash' }
  }).catch(() => {});
  const [oct] = await months(biz);
  assert.equal(oct.tookPaisa, 0);
});
