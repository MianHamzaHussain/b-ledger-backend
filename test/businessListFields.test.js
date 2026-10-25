import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, makeBusiness } from './helpers/db.js';
import Business from '../models/Business.js';
import { BUSINESS_LIST_FIELDS } from '../utils/businessListFields.js';

/**
 * The reset screen picks businesses from the LIST, so the list must say which are protected.
 */
before(connect);
after(disconnect);
afterEach(clear);

test('a business in the list says whether it is protected as real data', async () => {
  const biz = await makeBusiness();
  await Business.updateOne({ _id: biz._id }, { isProtected: true });
  const [row] = await Business.find({}).select(BUSINESS_LIST_FIELDS).lean();
  assert.equal(row.isProtected, true);
  assert.equal(row.codTax, undefined, 'the list stays lean');
});
