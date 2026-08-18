import { test } from 'node:test';
import assert from 'node:assert/strict';

import advancedResults from '../middlewares/advancedResults.js';

/**
 * Guards the list-query behaviour across the Express 4 → 5 upgrade. Express 5's
 * default query parser is "simple" (flat `qty[gte]` keys) where Express 4 used
 * qs (nested `{ qty: { gte } }`). advancedResults must map BOTH to `$gte`, and
 * server.js pins `query parser: extended` to keep Express 4 semantics — so these
 * assertions must hold either way. No database: a chainable mock records the
 * filter handed to `find()`.
 */
function mockModel() {
  const calls = { filter: null, countFilter: null };
  const query = {
    select() {
      return this;
    },
    sort() {
      return this;
    },
    skip() {
      return this;
    },
    limit() {
      return this;
    },
    populate() {
      return this;
    },
    // eslint-disable-next-line unicorn/no-thenable -- intentional: advancedResults does `await query`
    then(resolve) {
      return resolve([]);
    }
  };
  return {
    modelName: 'Thing',
    find(f) {
      calls.filter = f;
      return query;
    },
    countDocuments(f) {
      calls.countFilter = f;
      return Promise.resolve(0);
    },
    _calls: calls
  };
}

function run(query, accessFilter = {}) {
  const model = mockModel();
  const req = { query, accessFilter };
  return new Promise((resolve, reject) => {
    advancedResults(model)(req, {}, err => (err ? reject(err) : resolve(model._calls)));
  });
}

test('nested operator form (Express 4 / extended parser): qty[gte] -> $gte', async () => {
  const { filter } = await run({ qty: { gte: '20' } });
  assert.deepEqual(filter, { qty: { $gte: '20' } });
});

test('flat operator key (Express 5 simple parser): "qty[gte]" -> $gte', async () => {
  const { filter } = await run({ 'qty[gte]': '20' });
  assert.deepEqual(filter, { qty: { $gte: '20' } });
});

test('scope accessFilter is merged under $and, never spread', async () => {
  const { filter } = await run({ status: 'active' }, { business: 'b1' });
  assert.deepEqual(filter, { $and: [{ status: 'active' }, { business: 'b1' }] });
});

test('client-supplied $ operators are stripped (never reach find as operators)', async () => {
  const { filter } = await run({ role: { $ne: 'admin' } });
  // $ne is removed; the now-empty `role` object is harmless (matches nothing).
  assert.deepEqual(filter, { role: {} });
});
