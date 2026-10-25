import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import {
  connect,
  clear,
  disconnect,
  makeBusiness,
  makeParty,
  makeProduct,
  runHandler,
  oid
} from './helpers/db.js';
import Business from '../models/Business.js';
import { resetData, resetPreview } from '../controllers/systemController.js';
import { businessModels } from '../utils/businessData.js';

/**
 * The testing reset clears ONE business's records — and only when the server opted in, the
 * business is not marked as real data, and its exact name was typed. Everything else (other
 * businesses, users, roles) is left alone, and a copy is written first.
 */

const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bledger-reset-'));
process.env.RESET_SNAPSHOT_DIR = snapshotDir;

before(connect);
after(async () => {
  fs.rmSync(snapshotDir, { recursive: true, force: true });
  await disconnect();
});
afterEach(() => {
  delete process.env.ALLOW_DATA_RESET;
  return clear();
});

const col = name => mongoose.connection.collection(name);
const reset = (biz, confirmName = biz.name) =>
  runHandler(resetData, {
    user: { id: oid() },
    body: { business: String(biz._id), confirmName }
  });

test('refuses unless the server enables it', async () => {
  const biz = await makeBusiness();
  await assert.rejects(reset(biz), /disabled/);
});

test('refuses when the typed name is not the business name', async () => {
  process.env.ALLOW_DATA_RESET = 'true';
  const biz = await makeBusiness();
  await makeParty(biz._id, 'courier');
  await assert.rejects(reset(biz, 'RESET'), /Type the business name exactly/);
  await assert.rejects(reset(biz, biz.name.toLowerCase()), /Type the business name exactly/);
  assert.equal(await col('parties').countDocuments(), 1, 'nothing was deleted');
});

test('refuses a business marked as real data, even with the right name', async () => {
  process.env.ALLOW_DATA_RESET = 'true';
  const biz = await makeBusiness();
  await Business.updateOne({ _id: biz._id }, { isProtected: true });
  await makeParty(biz._id, 'courier');
  await assert.rejects(reset(biz), /protected/);
  assert.equal(await col('parties').countDocuments(), 1);
});

test('an unknown business is a 404, not a wipe', async () => {
  process.env.ALLOW_DATA_RESET = 'true';
  await assert.rejects(
    runHandler(resetData, {
      user: { id: oid() },
      body: { business: String(oid()), confirmName: 'x' }
    }),
    /not found/
  );
});

test('clears that business only — other businesses, users and roles are untouched', async () => {
  process.env.ALLOW_DATA_RESET = 'true';
  const test1 = await makeBusiness({ name: 'Test Shop' });
  const real = await makeBusiness({ name: 'Real Shop' });
  await makeParty(test1._id, 'courier');
  await makeProduct(test1._id);
  await makeParty(real._id, 'courier');
  await makeProduct(real._id);
  await col('roles').insertOne({ name: 'Dispatcher' });
  await col('users').insertOne({ name: 'Ali', assignedBusinesses: [test1._id, real._id] });

  const out = await reset(test1);
  assert.equal(out.body.success, true);
  assert.equal(out.body.data.cleared['khata people'], 1);
  assert.equal(out.body.data.cleared.articles, 1);

  assert.equal(await col('parties').countDocuments({ business: test1._id }), 0);
  assert.equal(await col('products').countDocuments({ business: test1._id }), 0);
  assert.equal(await col('parties').countDocuments({ business: real._id }), 1, 'real data kept');
  assert.equal(await col('products').countDocuments({ business: real._id }), 1);
  assert.equal(await col('businesses').countDocuments(), 2, 'the business itself stays');
  assert.equal(await col('roles').countDocuments(), 1);
  const user = await col('users').findOne({ name: 'Ali' });
  assert.equal(user.assignedBusinesses.length, 2, 'assignments kept');
});

test('writes a safety copy of the records before deleting', async () => {
  process.env.ALLOW_DATA_RESET = 'true';
  const biz = await makeBusiness();
  await makeParty(biz._id, 'courier');
  await reset(biz);
  const file = fs.readdirSync(snapshotDir).find(f => f.startsWith(String(biz._id)));
  assert.ok(file, 'snapshot file exists');
  const lines = fs
    .readFileSync(path.join(snapshotDir, file), 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l));
  assert.ok(lines.some(l => l.collection === 'businesses'));
  assert.ok(lines.some(l => l.collection === 'parties'));
});

test('preview counts what a reset would delete and says whether the business is locked', async () => {
  const biz = await makeBusiness();
  await makeParty(biz._id, 'courier');
  await makeProduct(biz._id);
  const out = await runHandler(resetPreview, {
    user: { id: oid() },
    query: { business: String(biz._id) }
  });
  assert.equal(out.body.data.business.name, biz.name);
  assert.equal(out.body.data.business.isProtected, false);
  assert.equal(out.body.data.counts['khata people'], 1);
  assert.equal(out.body.data.counts.articles, 1);
  assert.equal(out.body.data.lastOrderAt, null);
});

test('every model that carries a business is covered by the reset', async () => {
  const dir = path.join(import.meta.dirname, '..', 'models');
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
    const { default: model } = await import(
      path.join(dir, file).replace(/\\/g, '/').replace(/^/, 'file:///')
    );
    if (!model?.schema?.path('business')) continue;
    assert.ok(
      businessModels().some(m => m.modelName === model.modelName),
      `${model.modelName} has a business but is not in utils/businessData.js`
    );
  }
});
