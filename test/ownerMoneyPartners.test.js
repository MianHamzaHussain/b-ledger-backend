import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, makeBusiness, runHandler, userId } from './helpers/db.js';
import Partner from '../models/Partner.js';
import JournalEntry from '../models/JournalEntry.js';
import { recordCapital } from '../controllers/financeController.js';
import { createPartner, withdrawPartner, investPartner } from '../controllers/partnerController.js';
import { profitAndLoss } from '../utils/reports.js';
import { toPaisa } from '../utils/money.js';
import { capitalSchema } from '../schemas/finance.js';

/**
 * Who took the money is the whole point of an owner withdrawal. When a business has partners
 * it goes against a partner's own capital; the shared owner account would leave nobody named,
 * so the server refuses it — whatever the screen showed or the person could see.
 */

before(connect);
after(disconnect);
afterEach(clear);

const admin = { id: userId, role: { fullAccess: true } };

const shared = (biz, direction, amount = 1000, extra = {}) =>
  runHandler(recordCapital, {
    user: admin,
    body: capitalSchema.parse({
      business: String(biz._id),
      amount,
      direction,
      method: 'cash',
      ...extra
    })
  });

const addPartner = (biz, name = 'Ali') =>
  runHandler(createPartner, {
    body: { business: String(biz._id), name, sharePercent: 50 }
  }).then(r => r.body.data);

const entries = biz => JournalEntry.countDocuments({ business: biz._id });

test('without partners, the shared owner account works both ways', async () => {
  const biz = await makeBusiness();
  assert.equal((await shared(biz, 'invest')).status, 201);
  assert.equal((await shared(biz, 'drawings')).status, 201);
  assert.equal(await entries(biz), 2);
});

test('with an active partner, taking money out through the shared account is refused', async () => {
  const biz = await makeBusiness();
  await addPartner(biz);
  const before = await entries(biz);

  await assert.rejects(shared(biz, 'drawings', 3000), /has partners.*choose which partner/);
  assert.equal(await entries(biz), before, 'nothing was written');
  assert.equal((await profitAndLoss(biz._id)).ownerTookPaisa, 0);
});

test('putting money in is refused the same way — it must name the partner too', async () => {
  const biz = await makeBusiness();
  await addPartner(biz);
  await assert.rejects(shared(biz, 'invest', 5000), /has partners/);
});

test('the refusal is a 400 with words a person can act on', async () => {
  const biz = await makeBusiness();
  await addPartner(biz);
  const error = await shared(biz, 'drawings').catch(e => e);
  assert.equal(error.statusCode, 400);
  assert.match(error.message, /Partners → Put money in \/ Take money out/);
});

test('the partner’s own route still works, and is what counts as the owner taking it', async () => {
  const biz = await makeBusiness();
  const ali = await addPartner(biz);
  await runHandler(investPartner, {
    resource: await Partner.findById(ali._id),
    user: admin,
    body: { amount: 10000, method: 'cash' }
  });
  await runHandler(withdrawPartner, {
    resource: await Partner.findById(ali._id),
    user: admin,
    body: { amount: 3000, method: 'cash', memo: 'Home expense — Ali' }
  });
  assert.equal((await profitAndLoss(biz._id)).ownerTookPaisa, toPaisa(3000));
  assert.ok(await JournalEntry.findOne({ business: biz._id, memo: 'Home expense — Ali' }));
});

test('a partner who has left no longer blocks the shared account', async () => {
  const biz = await makeBusiness();
  const ali = await addPartner(biz);
  await Partner.updateOne({ _id: ali._id }, { isActive: false });
  assert.equal((await shared(biz, 'drawings')).status, 201);
});

test('partners in another business do not matter', async () => {
  const mine = await makeBusiness();
  const other = await makeBusiness({ name: 'Other Biz' });
  await addPartner(other);
  assert.equal((await shared(mine, 'drawings')).status, 201);
});
