import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loginSchema, updatePasswordSchema } from '../schemas/auth.js';
import { businessCreateSchema, businessUpdateSchema } from '../schemas/businesses.js';
import { categoryCreateSchema } from '../schemas/categories.js';
import { partyCreateSchema } from '../schemas/parties.js';
import { customerUpdateSchema } from '../schemas/customers.js';
import { pushSubscribeSchema } from '../schemas/push.js';

/**
 * These guard the new route schemas against the two ways a schema can be wrong:
 * it must ACCEPT a complete valid body without silently dropping a field (the
 * validate middleware replaces req.body with the parsed result), and it must
 * REJECT bad input so the 400 fires before the controller.
 */

test('login accepts email+password and phone+password, rejects neither', () => {
  assert.equal(loginSchema.safeParse({ email: 'a@b.pk', password: 'x' }).success, true);
  assert.equal(loginSchema.safeParse({ phone: '+92300', password: 'x' }).success, true);
  assert.equal(loginSchema.safeParse({ password: 'x' }).success, false); // no identifier
  assert.equal(loginSchema.safeParse({ email: 'a@b.pk' }).success, false); // no password
});

test('updatePassword enforces the 8-char minimum on the new password', () => {
  assert.equal(
    updatePasswordSchema.safeParse({ currentPassword: 'x', newPassword: 'short' }).success,
    false
  );
  assert.equal(
    updatePasswordSchema.safeParse({ currentPassword: 'x', newPassword: 'longenough' }).success,
    true
  );
});

test('business create keeps every field (nested codTax survives), rejects missing name/category', () => {
  const r = businessCreateSchema.safeParse({
    name: 'Zeta',
    category: 'c1',
    storeLink: 'https://shop',
    whatsappNumber: '+92300',
    codTax: { registered: true, whtPercent: 2, salesTaxPercent: 3 },
    status: 'active'
  });
  assert.equal(r.success, true);
  assert.equal(r.data.codTax.whtPercent, 2); // not dropped
  assert.equal(r.data.storeLink, 'https://shop');
  assert.equal(businessCreateSchema.safeParse({ category: 'c1' }).success, false); // no name
  assert.equal(businessCreateSchema.safeParse({ name: 'Z' }).success, false); // no category
});

test('business update is fully partial', () => {
  assert.equal(businessUpdateSchema.safeParse({ name: 'Renamed' }).success, true);
  assert.equal(businessUpdateSchema.safeParse({}).success, true);
});

test('category create keeps variantOptions, rejects missing name', () => {
  const r = categoryCreateSchema.safeParse({
    name: 'Clothing',
    variantOptions: ['Size', 'Colour']
  });
  assert.equal(r.success, true);
  assert.deepEqual(r.data.variantOptions, ['Size', 'Colour']);
  assert.equal(categoryCreateSchema.safeParse({ description: 'x' }).success, false);
});

test('party create validates the type enum and requires business + name', () => {
  assert.equal(
    partyCreateSchema.safeParse({ business: 'b1', name: 'Ali', type: 'courier' }).success,
    true
  );
  assert.equal(
    partyCreateSchema.safeParse({ business: 'b1', name: 'Ali', type: 'not-a-type' }).success,
    false
  );
  assert.equal(partyCreateSchema.safeParse({ name: 'Ali', type: 'courier' }).success, false); // no business
});

test('customer update strips to name/phone/city and stays optional', () => {
  assert.equal(customerUpdateSchema.safeParse({ city: 'Lahore' }).success, true);
  const r = customerUpdateSchema.safeParse({ name: 'A', phone: '+92300', city: 'Lahore', junk: 1 });
  assert.equal(r.success, true);
  assert.equal('junk' in r.data, false); // unknown key stripped
});

test('push subscribe requires the full endpoint + keys shape', () => {
  assert.equal(
    pushSubscribeSchema.safeParse({
      subscription: { endpoint: 'https://push', keys: { p256dh: 'a', auth: 'b' } }
    }).success,
    true
  );
  assert.equal(
    pushSubscribeSchema.safeParse({ subscription: { endpoint: 'https://push' } }).success,
    false
  );
});
