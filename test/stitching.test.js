import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  connect,
  clear,
  disconnect,
  makeBusiness,
  makeProduct,
  runHandler,
  userId
} from './helpers/db.js';
import Product from '../models/Product.js';
import Material from '../models/Material.js';
import ProductionBatch from '../models/ProductionBatch.js';
import JournalEntry from '../models/JournalEntry.js';
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { accountBalance } from '../utils/ledger.js';
import { createBatch, closeBatch, updateBatch } from '../controllers/productionController.js';

/**
 * Stitching: a batch can take its pieces out of another size of the same product
 * (Unstitched → M, L). The pieces carry their cost; stock only moves between
 * sizes, so only the stitching costs (tailor, lace…) post to the books.
 */

before(connect);
after(disconnect);
afterEach(clear);

const admin = { id: userId, role: { fullAccess: true } };

async function setup() {
  const biz = await makeBusiness();
  const product = await makeProduct(biz._id, [
    { label: 'Unstitched', costPrice: 2500, salePrice: 4500, stock: 20 },
    { label: 'M', costPrice: 0, salePrice: 4500, stock: 0 },
    { label: 'L', costPrice: 0, salePrice: 4500, stock: 0 }
  ]);
  const id = label => String(product.variants.find(v => v.label === label)._id);
  return { biz, product, id };
}

const stockOf = async (ctx, label) =>
  (await Product.findById(ctx.product._id)).variants.find(v => v.label === label);

const stitch = (ctx, lines, extra = {}) =>
  runHandler(createBatch, {
    body: {
      business: String(ctx.biz._id),
      product: String(ctx.product._id),
      sourceVariantId: ctx.id('Unstitched'),
      lines,
      ...extra
    }
  });

const close = async (batchId, body = {}) =>
  runHandler(closeBatch, { resource: await ProductionBatch.findById(batchId), body });

const balance = async (ctx, code) =>
  accountBalance(ctx.biz._id, (await accountByCode(ctx.biz._id, code))._id);

/** M × 5 with a 2,000 tailor, L × 3 with nothing extra. */
const standardLines = ctx => [
  {
    variantId: ctx.id('M'),
    quantity: 5,
    costLines: [{ label: 'Tailor', amount: 2000, fund: 'cash' }]
  },
  { variantId: ctx.id('L'), quantity: 3, costLines: [] }
];

test('stitching moves stock between sizes and carries the cost; only the tailor posts', async () => {
  const ctx = await setup();
  const created = await stitch(ctx, standardLines(ctx));
  const batchId = created.body.data._id;
  await close(batchId);

  const unstitched = await stockOf(ctx, 'Unstitched');
  assert.equal(unstitched.stock, 12);
  assert.equal(unstitched.costPrice, 2500, 'the source size keeps its cost');
  const m = await stockOf(ctx, 'M');
  assert.equal(m.stock, 5);
  assert.equal(m.costPrice, 2900, '2,500 + 2,000 ÷ 5');
  const l = await stockOf(ctx, 'L');
  assert.equal(l.stock, 3);
  assert.equal(l.costPrice, 2500);

  assert.equal(await balance(ctx, CODES.CASH), -200000);
  assert.equal(await balance(ctx, CODES.INVENTORY), 200000, 'the moved 20,000 does not post');

  const closed = await ProductionBatch.findById(batchId);
  const moved = line => line.costLines.find(c => c.fromStock).amountPaisa;
  assert.equal(moved(closed.lines[0]), 1250000);
  assert.equal(moved(closed.lines[1]), 750000);
});

test('a stitch with no other cost closes with no entry at all', async () => {
  const ctx = await setup();
  const created = await stitch(ctx, [{ variantId: ctx.id('L'), quantity: 3, costLines: [] }]);
  await close(created.body.data._id);

  const batch = await ProductionBatch.findById(created.body.data._id);
  assert.equal(batch.status, 'closed');
  assert.equal(batch.closeEntry, undefined);
  assert.equal(await JournalEntry.countDocuments(), 0);
  assert.equal((await stockOf(ctx, 'L')).stock, 3);
  assert.equal((await stockOf(ctx, 'Unstitched')).stock, 17);
});

test('asking for more than the source holds refuses, changes nothing and returns material', async () => {
  const ctx = await setup();
  const dye = await Material.create({
    business: ctx.biz._id,
    name: 'Lace',
    unit: 'metre',
    stock: 10,
    valuePaisa: 10000,
    createdBy: userId
  });
  const created = await stitch(ctx, [
    {
      variantId: ctx.id('M'),
      quantity: 25,
      costLines: [{ material: String(dye._id), materialQty: 2 }]
    }
  ]);
  await assert.rejects(close(created.body.data._id), /Only 20 Unstitched in stock/);

  assert.equal((await stockOf(ctx, 'Unstitched')).stock, 20);
  assert.equal((await stockOf(ctx, 'M')).stock, 0);
  assert.equal((await Material.findById(dye._id)).stock, 10, 'the lace is back');
  assert.equal((await ProductionBatch.findById(created.body.data._id)).status, 'open');
});

test('a size can not be stitched from itself', async () => {
  const ctx = await setup();
  await assert.rejects(
    stitch(ctx, [{ variantId: ctx.id('Unstitched'), quantity: 2, costLines: [] }]),
    /stitched from itself/
  );
});

test('a from-stock cost sent by the client is ignored, not added on top', async () => {
  const ctx = await setup();
  const created = await stitch(ctx, [
    {
      variantId: ctx.id('M'),
      quantity: 5,
      costLines: [{ label: 'Fake', amount: 99999, fund: 'cash', fromStock: true }]
    }
  ]);
  await close(created.body.data._id);
  assert.equal((await stockOf(ctx, 'M')).costPrice, 2500, 'only the real moved cost');
  assert.equal(await balance(ctx, CODES.CASH), 0);
});

test('correcting a closed stitch keeps its from-stock lines and does not take stock again', async () => {
  const ctx = await setup();
  const created = await stitch(ctx, standardLines(ctx));
  const batchId = created.body.data._id;
  await close(batchId);

  await runHandler(updateBatch, {
    user: admin,
    resource: await ProductionBatch.findById(batchId),
    body: {
      lines: [
        {
          variantId: ctx.id('M'),
          quantity: 5,
          costLines: [{ label: 'Tailor', amount: 2500, fund: 'cash' }]
        },
        { variantId: ctx.id('L'), quantity: 3, costLines: [] }
      ]
    }
  });

  assert.equal((await stockOf(ctx, 'Unstitched')).stock, 12, 'no second take');
  const closed = await ProductionBatch.findById(batchId);
  const moved = closed.lines[0].costLines.find(c => c.fromStock);
  assert.equal(moved.amountPaisa, 1250000);
  assert.equal(closed.lines[0].costLines.find(c => c.label === 'Tailor').amountPaisa, 250000);
  assert.equal(await balance(ctx, CODES.CASH), -250000);
});
