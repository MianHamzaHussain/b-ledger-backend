import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  connect,
  clear,
  disconnect,
  makeBusiness,
  makeParty,
  runHandler,
  oid
} from './helpers/db.js';
import { resetData } from '../controllers/systemController.js';

/**
 * The testing reset wipes every business record but keeps users and roles —
 * and only when the server opted in and the caller typed the confirmation.
 */

before(connect);
after(disconnect);
afterEach(() => {
  delete process.env.ALLOW_DATA_RESET;
  return clear();
});

const col = name => mongoose.connection.collection(name);

test('refuses unless the server enables it', async () => {
  await assert.rejects(runHandler(resetData, { body: { confirm: 'RESET' } }), /disabled/);
});

test('refuses without the typed confirmation', async () => {
  process.env.ALLOW_DATA_RESET = 'true';
  await assert.rejects(runHandler(resetData, { body: { confirm: 'reset' } }), /Type RESET/);
});

test('wipes business data, keeps users and roles, clears assignments', async () => {
  process.env.ALLOW_DATA_RESET = 'true';
  const biz = await makeBusiness();
  await makeParty(biz._id, 'courier');
  await col('roles').insertOne({ name: 'Dispatcher' });
  await col('users').insertOne({ name: 'Ali', assignedBusinesses: [biz._id, oid()] });

  const out = await runHandler(resetData, { body: { confirm: 'RESET' } });
  assert.equal(out.body.success, true);

  assert.equal(await col('businesses').countDocuments(), 0);
  assert.equal(await col('parties').countDocuments(), 0);
  assert.equal(await col('accounts').countDocuments(), 0, 'chart of accounts wiped too');
  assert.equal(await col('roles').countDocuments(), 1, 'roles kept');

  const user = await col('users').findOne({ name: 'Ali' });
  assert.ok(user, 'user kept');
  assert.deepEqual(user.assignedBusinesses, [], 'assignments cleared');
});
