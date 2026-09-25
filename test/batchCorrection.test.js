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
import ProductionBatch from '../models/ProductionBatch.js';
import JournalEntry from '../models/JournalEntry.js';
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { accountBalance, postEntry } from '../utils/ledger.js';
import { createBatch, closeBatch, updateBatch } from '../controllers/productionController.js';
import { toPaisa } from '../utils/money.js';

/**
 * A closed batch's costs can be corrected by an admin only. The close entry is
 * reversed and re-posted, the cost difference on units still in stock is
 * re-averaged into the variant, and the share on units already sold is trued
 * up in COGS — so inventory and the product's valuation stay in step.
 */

before(connect);
after(disconnect);
afterEach(clear);

const admin = { id: userId, role: { fullAccess: true } };
const staff = { id: userId, role: { fullAccess: false, permissions: [] } };

const costLines = amount => [{ label: 'Cloth', amount, fund: 'cash' }];

/** 10 units closed at Rs 10,000 (unit 1,000), then 4 of them sold. */
async function closedBatchWithSales() {
  const biz = await makeBusiness();
  const product = await makeProduct(biz._id, [
    { label: 'M', costPrice: 0, salePrice: 2000, stock: 0 }
  ]);
  const variantId = String(product.variants[0]._id);

  const created = await runHandler(createBatch, {
    body: {
      business: String(biz._id),
      product: String(product._id),
      lines: [{ variantId, quantity: 10, costLines: costLines(10000) }]
    }
  });
  const batch = await ProductionBatch.findById(created.body.data._id);
  await runHandler(closeBatch, { resource: batch, body: {} });

  // Selling 4 units takes them out of stock and expenses them at the old cost.
  await Product.updateOne(
    { _id: product._id, 'variants._id': variantId },
    { $inc: { 'variants.$.stock': -4 } }
  );
  await postEntry({
    business: biz._id,
    memo: 'sale of 4',
    lines: [
      { account: (await accountByCode(biz._id, CODES.COGS))._id, debitPaisa: toPaisa(4000) },
      { account: (await accountByCode(biz._id, CODES.INVENTORY))._id, creditPaisa: toPaisa(4000) }
    ],
    userId
  });
  return { biz, product, variantId, batchId: batch._id };
}

const correct = async (batchId, user, lines) =>
  runHandler(updateBatch, {
    user,
    resource: await ProductionBatch.findById(batchId),
    body: { lines }
  });

test('only an admin can correct a closed batch', async () => {
  const { batchId, variantId } = await closedBatchWithSales();
  await assert.rejects(
    correct(batchId, staff, [{ variantId, quantity: 10, costLines: costLines(12000) }]),
    /Only an admin/
  );
});

test('variants and quantities of a closed batch are fixed', async () => {
  const { batchId, variantId } = await closedBatchWithSales();
  await assert.rejects(
    correct(batchId, admin, [{ variantId, quantity: 12, costLines: costLines(12000) }]),
    /quantities are fixed/
  );
});

test('a cost correction re-posts, re-averages stock and trues up COGS', async () => {
  const { biz, product, batchId, variantId } = await closedBatchWithSales();
  const before = await ProductionBatch.findById(batchId);

  const out = await correct(batchId, admin, [
    { variantId, quantity: 10, costLines: costLines(12000) }
  ]);

  // The old close entry is reversed and a new one takes its place.
  assert.notEqual(String(out.body.data.closeEntry), String(before.closeEntry));
  assert.ok(await JournalEntry.exists({ reversalOf: before.closeEntry }), 'reversed');
  assert.equal(out.body.data.totalCostPaisa, toPaisa(12000));

  // 6 units left: their share (6/10 of +2,000) lifts the unit cost to 1,200.
  const fresh = await Product.findById(product._id);
  assert.equal(fresh.variants[0].costPrice, 1200);
  assert.equal(fresh.variants[0].stock, 6, 'stock untouched');

  // 4 sold units: their share (4/10 of +2,000 = 800) moves to COGS — they now
  // cost 4 × 1,200 in total.
  const cogs = (await accountByCode(biz._id, CODES.COGS))._id;
  assert.equal(await accountBalance(biz._id, cogs), toPaisa(4800));

  // Inventory now holds exactly what is left: 6 × 1,200.
  const inventory = (await accountByCode(biz._id, CODES.INVENTORY))._id;
  assert.equal(await accountBalance(biz._id, inventory), toPaisa(7200));
});
