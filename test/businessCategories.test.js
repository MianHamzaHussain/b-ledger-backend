import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, makeProduct, runHandler, oid, userId } from './helpers/db.js';
import Business from '../models/Business.js';
import Category from '../models/Category.js';
import Product from '../models/Product.js';
import { categoriesOf, isCategoryOf } from '../utils/businessCategories.js';
import { updateBusiness } from '../controllers/businessController.js';
import { businessCreateSchema } from '../schemas/businesses.js';
import { backfillBusinessCategories } from '../utils/backfillBusinessCategories.js';
import Role from '../models/Role.js';
import User from '../models/User.js';
import { getMe } from '../controllers/authController.js';

/**
 * A business sells in one or more categories (the first is the default); `category` is a deprecated mirror of the
 * first so older app versions keep working until the contract round.
 */
before(connect);
after(disconnect);
afterEach(clear);

const [A, B, C] = [oid(), oid(), oid()];
const ids = list => list.map(String);
const make = extra => Business.create({ name: 'Biz', createdBy: userId, ...extra });
const update = (biz, body) =>
  runHandler(updateBusiness, { resource: biz, body, user: { id: userId } });

test('create with categories: the first is the default and the legacy mirror', async () => {
  const biz = await make({ categories: [A, B] });
  assert.deepEqual(ids(biz.categories), ids([A, B]));
  assert.equal(String(biz.category), String(A));
});

test('a legacy create with only `category` gets a one-item list', async () => {
  const biz = await make({ category: A });
  assert.deepEqual(ids(biz.categories), [String(A)]);
});

test('an older app changing only `category` moves it to the front and keeps the rest', async () => {
  const biz = await make({ categories: [A, B] });
  biz.category = C;
  await biz.save();
  assert.deepEqual(ids(biz.categories), ids([C, A, B]));
  const again = await Business.findById(biz._id);
  again.category = B;
  await again.save();
  assert.deepEqual(ids(again.categories), ids([B, C, A]));
});

test('setting categories moves the mirror with the first', async () => {
  const biz = await make({ categories: [A, B] });
  biz.categories = [B, A];
  await biz.save();
  assert.equal(String(biz.category), String(B));
});

test('duplicates collapse, keeping order', async () => {
  const biz = await make({ categories: [A, A, B] });
  assert.deepEqual(ids(biz.categories), ids([A, B]));
});

test('no category at all is refused; more than 20 is refused', async () => {
  await assert.rejects(make({ categories: [] }), /at least one category/);
  await assert.rejects(make({}), /at least one category/);
  await assert.rejects(
    make({ categories: Array.from({ length: 21 }, () => oid()) }),
    /at most 20 categories/
  );
});

test('a legacy document (category only, stored raw) reads and saves into the new shape', async () => {
  const _id = oid();
  await Business.collection.insertOne({ _id, name: 'Old', category: A, createdBy: userId });
  const raw = await Business.findById(_id).lean();
  assert.deepEqual(categoriesOf(raw), [String(A)]);
  const doc = await Business.findById(_id);
  doc.name = 'Old renamed';
  await doc.save();
  assert.deepEqual(ids((await Business.findById(_id)).categories), [String(A)]);
});

test('categoriesOf and isCategoryOf accept ids and populated objects', () => {
  const biz = { categories: [{ _id: A }, B] };
  assert.deepEqual(categoriesOf(biz), ids([A, B]));
  assert.ok(isCategoryOf(biz, B));
  assert.ok(!isCategoryOf(biz, C));
  assert.deepEqual(categoriesOf({ category: A }), [String(A)]);
  assert.deepEqual(categoriesOf(null), []);
});

test('a category an article is in can not be removed — the message has the count and the name', async () => {
  const cat = await Category.create({ name: 'Lehnga' });
  const biz = await make({ categories: [A, cat._id] });
  for (let i = 0; i < 2; i++) {
    const p = await makeProduct(biz._id);
    await Product.updateOne({ _id: p._id }, { category: cat._id });
  }

  await assert.rejects(update(biz, { categories: [String(A)] }), /2 articles are in Lehnga/);
  assert.deepEqual(ids((await Business.findById(biz._id)).categories), ids([A, cat._id]));
});

test('removing an unused category works, and an update without categories leaves them alone', async () => {
  const biz = await make({ categories: [A, B] });
  await update(biz, { categories: [String(A)] });
  assert.deepEqual(ids((await Business.findById(biz._id)).categories), [String(A)]);
  await update(await Business.findById(biz._id), { brandColor: '#112233' });
  assert.deepEqual(ids((await Business.findById(biz._id)).categories), [String(A)]);
});

test('the create schema takes categories or the old category, and refuses neither or too many', () => {
  const ok = body => businessCreateSchema.safeParse({ name: 'Z', ...body }).success;
  assert.equal(ok({ categories: ['a', 'b'] }), true);
  assert.equal(ok({ category: 'a' }), true);
  assert.equal(ok({}), false);
  assert.equal(ok({ categories: [] }), false);
  assert.equal(ok({ categories: Array.from({ length: 21 }, (_, i) => `c${i}`) }), false);
});

test('backfill: dry run counts, apply fills only the old ones, a second run finds nothing', async () => {
  const old = [oid(), oid()];
  for (const _id of old) {
    await Business.collection.insertOne({
      _id,
      name: `Old ${_id}`,
      category: A,
      createdBy: userId
    });
  }
  const modern = await make({ name: 'Modern', categories: [B, C] });

  assert.deepEqual(await backfillBusinessCategories(), { businesses: 2 });
  assert.equal((await Business.collection.findOne({ _id: old[0] })).categories, undefined);

  await backfillBusinessCategories({ apply: true });
  for (const _id of old) {
    assert.deepEqual(ids((await Business.collection.findOne({ _id })).categories), [String(A)]);
  }
  assert.deepEqual(ids((await Business.findById(modern._id)).categories), ids([B, C]));
  assert.deepEqual(await backfillBusinessCategories({ apply: true }), { businesses: 0 });
});

test('/auth/me gives staff every category of their businesses, with sizes (not only the first)', async () => {
  const [clothing, lehnga] = await Category.create([
    { name: 'Clothing', variantOptions: ['S', 'M'] },
    { name: 'Lehnga', variantOptions: ['M', 'Custom'] }
  ]);
  const biz = await make({ categories: [clothing._id, lehnga._id] });
  const role = await Role.create({ name: 'Staff', permissions: [] });
  const staff = await User.create({
    name: 'Ali',
    email: 'ali@b-ledger.pk',
    phone: '+923001234567',
    password: 'password1',
    role: role._id,
    assignedBusinesses: [biz._id]
  });
  const out = await runHandler(getMe, { user: { id: staff._id } });
  const [assigned] = out.body.data.assignedBusinesses;
  assert.deepEqual(
    assigned.categories.map(c => c.name),
    ['Clothing', 'Lehnga']
  );
  assert.deepEqual(assigned.categories[1].variantOptions, ['M', 'Custom']);
  assert.equal(assigned.category.name, 'Clothing', 'the old field still there for older apps');
});
