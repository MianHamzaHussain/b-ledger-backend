import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushPayloadFor, worksOnSeveral } from '../utils/pushHelper.js';

/**
 * A phone notification says which business it comes from — but only to someone who works on more than one,
 * and it always carries the business so a tap opens it in the right one.
 */
const base = {
  title: 'New order #0122',
  body: 'Arham Ali, Rs 16,000',
  url: '/orders/o1',
  businessId: 'b2',
  businessName: 'Qam Style'
};

test('someone with several businesses sees the business at the start of the title', () => {
  const out = JSON.parse(pushPayloadFor({ ...base, showBusiness: true }));
  assert.equal(out.title, 'Qam Style · New order #0122');
  assert.equal(out.body, 'Arham Ali, Rs 16,000');
});

test('someone with a single business is spared the repetition', () => {
  const out = JSON.parse(pushPayloadFor({ ...base, showBusiness: false }));
  assert.equal(out.title, 'New order #0122');
});

test('the business id always travels, so a tap opens it in the right business', () => {
  for (const showBusiness of [true, false]) {
    const out = JSON.parse(pushPayloadFor({ ...base, showBusiness }));
    assert.equal(out.business, 'b2');
    assert.equal(out.url, '/orders/o1');
    assert.equal(out.businessName, 'Qam Style');
  }
});

test('a business with no name never puts "undefined" in the title', () => {
  const out = JSON.parse(pushPayloadFor({ ...base, businessName: undefined, showBusiness: true }));
  assert.equal(out.title, 'New order #0122');
  assert.ok(!('businessName' in out) || out.businessName === undefined);
});

test('missing title, body and link fall back to something sensible', () => {
  const out = JSON.parse(pushPayloadFor({ businessId: 'b1', showBusiness: false }));
  assert.equal(out.title, 'Update');
  assert.equal(out.body, 'You have a new update.');
  assert.equal(out.url, '/dashboard');
});

test('an Admin works on several businesses once there is more than one; anyone else by their own assignments', () => {
  assert.equal(worksOnSeveral(true, 0, 3), true);
  assert.equal(worksOnSeveral(true, 0, 1), false);
  assert.equal(worksOnSeveral(false, 2, 5), true);
  assert.equal(worksOnSeveral(false, 1, 5), false);
  assert.equal(worksOnSeveral(false, 0, 5), false);
});
