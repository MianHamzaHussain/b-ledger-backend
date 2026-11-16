import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, makeBusiness, runHandler, oid, userId } from './helpers/db.js';
import Business from '../models/Business.js';
import Category from '../models/Category.js';
import Product from '../models/Product.js';
import { createProduct, updateProduct } from '../controllers/productController.js';
import { deleteCategory } from '../controllers/categoryController.js';
import advancedResults from '../middlewares/advancedResults.js';

/**
 * An article is in exactly one of its business's categories: chosen, or the business's first; anything else is
 * refused. An older article whose category is no longer on the business's list still takes stock and price saves.
 */
before(connect);
after(disconnect);
afterEach(clear);

async function setup() {
  const [clothing, lehnga, other] = await Category.create([
    { name: 'Clothing' },
    { name: 'Lehnga' },
    { name: 'Shoes' }
  ]);
  const biz = await makeBusiness({ categories: [clothing._id, lehnga._id] });
  return { biz, clothing, lehnga, other };
}

const variants = [{ label: 'M', salePrice: 3000 }];
const create = (ctx, extra = {}) =>
  runHandler(createProduct, {
    body: { business: String(ctx.biz._id), name: 'Suit', createdBy: userId, variants, ...extra }
  }).then(r => r.body.data);

test('no category chosen → the business default (its first)', async () => {
  const ctx = await setup();
  assert.equal(String((await create(ctx)).category._id), String(ctx.clothing._id));
});

test('a chosen category of the business is kept, and comes back populated', async () => {
  const ctx = await setup();
  const made = await create(ctx, { category: String(ctx.lehnga._id) });
  assert.equal(made.category.name, 'Lehnga');
});

test('a category the business does not sell in is refused and nothing is saved', async () => {
  const ctx = await setup();
  await assert.rejects(
    create(ctx, { category: String(ctx.other._id) }),
    /Choose one of this business's categories/
  );
  assert.equal(await Product.countDocuments(), 0);
  await assert.rejects(create(ctx, { category: 'nonsense' }));
  assert.equal(await Product.countDocuments(), 0);
});

test('moving an article to another of its categories is saved; to a foreign one is refused', async () => {
  const ctx = await setup();
  const made = await create(ctx);
  const run = async category =>
    runHandler(updateProduct, {
      resource: await Product.findById(made._id),
      body: { category },
      user: { id: userId }
    });
  await run(String(ctx.lehnga._id));
  assert.equal(String((await Product.findById(made._id)).category), String(ctx.lehnga._id));
  await assert.rejects(run(String(ctx.other._id)), /Choose one of this business's categories/);
  assert.equal(String((await Product.findById(made._id)).category), String(ctx.lehnga._id));
});

test('an older article outside the business list still takes a price and name save', async () => {
  const ctx = await setup();
  const made = await create(ctx);
  await Product.collection.updateOne({ _id: made._id }, { $set: { category: ctx.other._id } });
  await runHandler(updateProduct, {
    resource: await Product.findById(made._id),
    body: { name: 'Renamed', variants: [{ _id: String(made.variants[0]._id), salePrice: 3500 }] },
    user: { id: userId }
  });
  const fresh = await Product.findById(made._id);
  assert.equal(fresh.name, 'Renamed');
  assert.equal(fresh.variants[0].salePrice, 3500);
  assert.equal(String(fresh.category), String(ctx.other._id), 'left as it was');
});

test('a legacy business (category only) still gives its articles that category', async () => {
  const cat = await Category.create({ name: 'Clothing' });
  const _id = oid();
  await Business.collection.insertOne({ _id, name: 'Old', category: cat._id, createdBy: userId });
  const p = await Product.create({ business: _id, name: 'X', createdBy: userId, variants });
  assert.equal(String(p.category), String(cat._id));
});

test('articles of one business can be listed by category', async () => {
  const ctx = await setup();
  await create(ctx);
  await create(ctx, { name: 'Bridal', category: String(ctx.lehnga._id) });
  const inLehnga = await Product.find({ business: ctx.biz._id, category: ctx.lehnga._id });
  assert.deepEqual(
    inLehnga.map(p => p.name),
    ['Bridal']
  );
});

test('a category can not be deleted while a business lists it (even second) or an article is in it', async () => {
  const ctx = await setup();
  const del = async category =>
    runHandler(deleteCategory, { resource: await Category.findById(category._id) });
  await assert.rejects(del(ctx.lehnga), /business still uses this/);

  const free = await Category.create({ name: 'Free' });
  const lonely = await Category.create({ name: 'Used by an article only' });
  const p = await create(ctx);
  await Product.collection.updateOne({ _id: p._id }, { $set: { category: lonely._id } });
  await assert.rejects(del(lonely), /article still uses this/);
  await del(free);
  assert.equal(await Category.exists({ _id: free._id }), null);
});

test('the real list route filters by ?category= (advancedResults)', async () => {
  const ctx = await setup();
  await create(ctx);
  await create(ctx, { name: 'Bridal', category: String(ctx.lehnga._id) });
  const req = {
    query: { business: String(ctx.biz._id), category: String(ctx.lehnga._id) },
    accessFilter: {}
  };
  const res = {};
  await new Promise((resolve, reject) =>
    advancedResults(
      Product,
      null,
      ['name'],
      'name category'
    )(req, res, err => (err ? reject(err) : resolve()))
  );
  assert.deepEqual(
    res.advancedResults.data.map(p => p.name),
    ['Bridal']
  );
});
