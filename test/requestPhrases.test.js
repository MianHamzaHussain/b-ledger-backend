import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, makeBusiness, runHandler, oid } from './helpers/db.js';
import Business from '../models/Business.js';
import { getRequestPhrases, setRequestPhrases } from '../controllers/orderController.js';
import { orderPhrasesSchema } from '../schemas/orders.js';

/**
 * A business's own one-tap requests for the courier slip: anyone who can change orders may keep them,
 * only for their own businesses, short and de-duplicated, at most 12.
 */
before(connect);
after(disconnect);
afterEach(clear);

/** What `can()` + `restrictBusinessToScope()` leave on the request for a user of these businesses. */
const scopedTo = (...businesses) => ({
  accessFilter: { business: { $in: businesses.map(b => b._id) } }
});

test('a new business starts with none of its own', async () => {
  const biz = await makeBusiness();
  const { body } = await runHandler(getRequestPhrases, {
    query: { business: String(biz._id) },
    ...scopedTo(biz)
  });
  assert.deepEqual(body.data, []);
});

test('saving replaces the list, trims, and drops a duplicate whatever its letter case', async () => {
  const biz = await makeBusiness();
  const { body } = await runHandler(setRequestPhrases, {
    body: { business: String(biz._id), phrases: ['Call first', 'call FIRST', 'Leave with guard'] }
  });
  assert.deepEqual(body.data, ['Call first', 'Leave with guard']);
  assert.deepEqual((await Business.findById(biz._id)).requestPhrases.toObject(), body.data);

  const { body: next } = await runHandler(setRequestPhrases, {
    body: { business: String(biz._id), phrases: [] }
  });
  assert.deepEqual(next.data, [], 'an empty list clears them');
});

test('another business is never readable by someone outside it (writes are scoped by restrictBusinessToScope)', async () => {
  const mine = await makeBusiness();
  const theirs = await makeBusiness({ name: 'Other Biz' });
  await Business.updateOne({ _id: theirs._id }, { $set: { requestPhrases: ['secret'] } });

  await assert.rejects(
    runHandler(getRequestPhrases, { query: { business: String(theirs._id) }, ...scopedTo(mine) }),
    err => err.statusCode === 404,
    'outside your scope is a 404, not a 403'
  );
});

test('a business that does not exist is a 404', async () => {
  const biz = await makeBusiness();
  await assert.rejects(
    runHandler(getRequestPhrases, { query: { business: 'not-an-id' }, ...scopedTo(biz) }),
    err => err.statusCode === 404
  );
  await assert.rejects(
    runHandler(setRequestPhrases, {
      body: { business: String(oid()), phrases: ['x'] }
    }),
    err => err.statusCode === 404
  );
});

test('the schema refuses an empty, an over-long and a 13th phrase', () => {
  const ok = { business: 'b', phrases: ['Call first'] };
  assert.equal(orderPhrasesSchema.safeParse(ok).success, true);
  assert.equal(orderPhrasesSchema.safeParse({ ...ok, phrases: ['   '] }).success, false);
  assert.equal(orderPhrasesSchema.safeParse({ ...ok, phrases: ['x'.repeat(61)] }).success, false);
  const thirteen = Array.from({ length: 13 }, (_, i) => `request ${i}`);
  assert.equal(orderPhrasesSchema.safeParse({ ...ok, phrases: thirteen }).success, false);
  assert.equal(
    orderPhrasesSchema.safeParse({ ...ok, phrases: thirteen.slice(0, 12) }).success,
    true
  );
});

test('the schema trims what it keeps', () => {
  const parsed = orderPhrasesSchema.parse({ business: 'b', phrases: ['  Call first  '] });
  assert.deepEqual(parsed.phrases, ['Call first']);
});
