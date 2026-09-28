import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  connect,
  clear,
  disconnect,
  makeBusiness,
  makeProduct,
  makeParty,
  runHandler
} from './helpers/db.js';
import { getGettingStarted } from '../controllers/businessController.js';
import { recordPartyTransaction } from '../controllers/partyController.js';
import { partyTransactionSchema } from '../schemas/parties.js';

/**
 * The getting-started checklist ticks itself off from real data, so a new
 * business sees what's left without anyone marking steps done by hand.
 */

before(connect);
after(disconnect);
afterEach(clear);

const steps = async biz => (await runHandler(getGettingStarted, { resource: biz })).body.data;

test('a fresh business has only itself', async () => {
  const biz = await makeBusiness();
  const s = await steps(biz);
  assert.equal(s.business, true);
  for (const key of [
    'moneyAccounts',
    'capital',
    'khataPeople',
    'khataEntry',
    'products',
    'production',
    'order',
    'delivered',
    'courierInvoice'
  ]) {
    assert.equal(s[key], false, key);
  }
});

test('steps tick as the data appears', async () => {
  const biz = await makeBusiness();
  await makeProduct(biz._id);
  const supplier = await makeParty(biz._id, 'supplier');
  let s = await steps(biz);
  assert.equal(s.products, true);
  assert.equal(s.khataPeople, true);
  assert.equal(s.khataEntry, false, 'a person alone is not an entry');

  await runHandler(recordPartyTransaction, {
    resource: supplier,
    body: partyTransactionSchema.parse({ direction: 'gave', amount: 500 })
  });
  s = await steps(biz);
  assert.equal(s.khataEntry, true);
});
