import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connect, clear, disconnect } from './helpers/db.js';
import Role from '../models/Role.js';
import { renameCouriersPermission } from '../utils/renameCouriersPermission.js';

/**
 * The stored "couriers" permission is renamed to "integrations" once, without touching anything else.
 */
before(connect);
after(disconnect);
afterEach(clear);

// Inserted raw: the Role schema (rightly) refuses the old resource name.
const oldRole = () =>
  Role.collection.insertOne({
    name: `Dispatcher ${new mongoose.Types.ObjectId()}`,
    permissions: [
      { resource: 'orders', actions: ['read'], scope: 'own' },
      { resource: 'couriers', actions: ['read', 'update'], scope: 'own' }
    ]
  });

test('a dry run counts the old permission and changes nothing', async () => {
  const { insertedId } = await oldRole();
  const out = await renameCouriersPermission();

  assert.deepEqual(out, { roles: 1, users: 0 });
  const role = await Role.collection.findOne({ _id: insertedId });
  assert.equal(role.permissions[1].resource, 'couriers');
});

test('applying renames only that row, keeps its actions and scope, and leaves the other rows alone', async () => {
  const { insertedId } = await oldRole();
  await renameCouriersPermission({ apply: true });

  const role = await Role.collection.findOne({ _id: insertedId });
  assert.deepEqual(role.permissions, [
    { resource: 'orders', actions: ['read'], scope: 'own' },
    { resource: 'integrations', actions: ['read', 'update'], scope: 'own' }
  ]);
});

test('running it twice is safe: the second run finds nothing', async () => {
  await oldRole();
  await renameCouriersPermission({ apply: true });
  assert.deepEqual(await renameCouriersPermission({ apply: true }), { roles: 0, users: 0 });
});

test('a person override is renamed as well', async () => {
  const users = mongoose.connection.collection('users');
  const { insertedId } = await users.insertOne({
    name: 'Override Person',
    email: `o${Date.now()}@example.com`,
    permissionOverrides: [
      { resource: 'couriers', actions: ['read'], effect: 'grant', scope: 'all' }
    ]
  });
  assert.equal((await renameCouriersPermission({ apply: true })).users, 1);

  const person = await users.findOne({ _id: insertedId });
  assert.equal(person.permissionOverrides[0].resource, 'integrations');
  assert.equal(person.permissionOverrides[0].effect, 'grant');
});
