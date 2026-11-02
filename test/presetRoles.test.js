import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect } from './helpers/db.js';
import Role from '../models/Role.js';
import { BUSINESS_OWNER_ROLE_NAME } from '../utils/constants.js';
import { RESOURCES, resolvePermissions } from '../utils/permissions.js';
import {
  NOT_FOR_OWNERS,
  OWNER_ACCESS,
  ensureBusinessOwnerRole,
  ownerPermissions
} from '../utils/presetRoles.js';
import { assertWithinCeiling, reachOf } from '../utils/delegation.js';

/**
 * The predefined Business Owner: the boss of a business, with everything for their OWN businesses.
 */
before(connect);
after(disconnect);
afterEach(clear);

test('every permission area is either given to owners or deliberately left to an Admin, none is forgotten', () => {
  const decided = new Set([...Object.keys(OWNER_ACCESS), ...NOT_FOR_OWNERS]);
  const undecided = Object.keys(RESOURCES).filter(key => !decided.has(key));
  assert.deepEqual(
    undecided,
    [],
    `Decide for ${undecided.join(', ')}: add it to OWNER_ACCESS or NOT_FOR_OWNERS in utils/presetRoles.js`
  );
  assert.ok(Object.keys(OWNER_ACCESS).every(key => !NOT_FOR_OWNERS.includes(key)));
});

test('the owner runs their own businesses end to end, including people, roles and integrations', () => {
  const rows = Object.fromEntries(ownerPermissions().map(p => [p.resource, p]));

  for (const area of [
    'users',
    'roles',
    'integrations',
    'orders',
    'products',
    'production',
    'journal'
  ]) {
    assert.ok(rows[area], `owners hold ${area}`);
  }
  assert.deepEqual(rows.users.actions, ['read', 'create', 'update', 'delete']);
  assert.deepEqual(rows.roles.actions, ['read', 'create', 'update', 'delete']);
  assert.deepEqual(rows.integrations.actions, ['read', 'create', 'update']);
  assert.equal(rows.accounting, undefined, 'accountant tools stay with an Admin');
});

test('a business is theirs to read and change, but created and removed by an Admin', () => {
  const businesses = ownerPermissions().find(p => p.resource === 'businesses');
  assert.deepEqual(businesses.actions, ['read', 'update']);
});

test('everything is limited to their own businesses; shared areas have no per-business scope', () => {
  for (const p of ownerPermissions()) {
    assert.equal(p.scope, RESOURCES[p.resource].scopable ? 'own' : 'all', p.resource);
  }
});

test('every action it lists is a real one for that area', () => {
  for (const p of ownerPermissions()) {
    const real = Object.keys(RESOURCES[p.resource].can);
    assert.ok(
      p.actions.every(a => real.includes(a)),
      p.resource
    );
  }
});

test('the role is created once, by name, and the same call again changes nothing', async () => {
  assert.equal(await ensureBusinessOwnerRole(), true);
  assert.equal(await ensureBusinessOwnerRole(), false);
  const found = await Role.find({ name: BUSINESS_OWNER_ROLE_NAME });
  assert.equal(found.length, 1);
  assert.equal(found[0].fullAccess, false);
  assert.equal(found[0].isSystem, false, 'an Admin can still tune it');
  assert.equal(found[0].business ?? null, null, 'it is not tied to one business');
});

test('an Admin edit to the role is never overwritten at the next start', async () => {
  await ensureBusinessOwnerRole();
  await Role.updateOne(
    { name: BUSINESS_OWNER_ROLE_NAME },
    { $set: { permissions: [{ resource: 'orders', actions: ['read'], scope: 'own' }] } }
  );

  assert.equal(await ensureBusinessOwnerRole(), false);
  const role = await Role.findOne({ name: BUSINESS_OWNER_ROLE_NAME });
  assert.deepEqual(
    role.permissions.map(p => p.resource),
    ['orders']
  );
});

test('an owner holding it manages their own people and roles within the ceiling, never the keys', async () => {
  await ensureBusinessOwnerRole();
  const role = await Role.findOne({ name: BUSINESS_OWNER_ROLE_NAME });
  const owner = { _id: 'o1', role, assignedBusinesses: ['b1'] };
  const row = (resource, actions, scope = 'own') => [{ resource, actions, scope }];

  // Their reach over people and roles is their own businesses, not everyone.
  assert.equal(reachOf(owner, 'users').all, false);
  assert.equal(reachOf(owner, 'roles').all, false);

  // They can give what they hold...
  assert.doesNotThrow(() => assertWithinCeiling(owner, row('orders', ['read', 'update'])));
  // ...but never the keys, nor what they do not hold, nor a wider scope than theirs.
  assert.throws(() => assertWithinCeiling(owner, row('users', ['read'])), /Only an Admin/);
  assert.throws(() => assertWithinCeiling(owner, row('accounting', ['read'])), /Only an Admin/);
  assert.throws(() => assertWithinCeiling(owner, row('reports', ['create'])), /do not have it/);
  assert.throws(() => assertWithinCeiling(owner, row('orders', ['read'], 'all')), /wider access/);

  // And what the permission resolver sees for a Business Owner is the list above.
  const seen = resolvePermissions({ role });
  assert.equal(seen.get('users').scope, 'own');
  assert.ok(seen.get('integrations').actions.has('update'));
});
