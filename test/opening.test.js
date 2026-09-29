import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  connect,
  clear,
  disconnect,
  makeBusiness,
  makeProduct,
  makeParty,
  runHandler,
  userId
} from './helpers/db.js';
import Material from '../models/Material.js';
import ProductionBatch from '../models/ProductionBatch.js';
import Product from '../models/Product.js';
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { accountBalance, partyBalance } from '../utils/ledger.js';
import { profitAndLoss } from '../utils/reports.js';
import { recordPartyOpeningBalance } from '../controllers/partyController.js';
import { createBatch, closeBatch } from '../controllers/productionController.js';
import { buyMaterial } from '../controllers/materialController.js';
import { partyOpeningSchema } from '../schemas/parties.js';
import { materialPurchaseSchema } from '../schemas/materials.js';

/**
 * Opening balances: what the business already had and owed the day it starts.
 * None of it moves cash or counts as this period's profit — it all sits against
 * Opening balances (equity).
 */

before(connect);
after(disconnect);
afterEach(clear);

const net = async (biz, code) => accountBalance(biz._id, (await accountByCode(biz._id, code))._id);
const opening = (party, body) =>
  runHandler(recordPartyOpeningBalance, { resource: party, body: partyOpeningSchema.parse(body) });

test('a supplier we owed and a reseller who owed us: Khata right, cash and profit untouched', async () => {
  const biz = await makeBusiness();
  const supplier = await makeParty(biz._id, 'supplier');
  const reseller = await makeParty(biz._id, 'reseller');

  await opening(supplier, { owesUs: false, amount: 40000 });
  await opening(reseller, { owesUs: true, amount: 25000 });

  assert.equal(await partyBalance(biz._id, supplier._id), -4000000, 'we owe the supplier');
  assert.equal(await partyBalance(biz._id, reseller._id), 2500000, 'the reseller owes us');
  assert.equal(await net(biz, CODES.CASH), 0);
  assert.equal(await net(biz, CODES.OPENING_BALANCES), 1500000);
  assert.equal((await profitAndLoss(biz._id)).netProfitPaisa, 0);
});

test('a lender can only be owed by us', async () => {
  const biz = await makeBusiness();
  const lender = await makeParty(biz._id, 'lender');
  await assert.rejects(opening(lender, { owesUs: true, amount: 1000 }), /still owe them/);
  await opening(lender, { owesUs: false, amount: 100000 });
  assert.equal(await net(biz, CODES.LOAN_PAYABLE), -10000000);
});

test('opening stock: into stock at its cost, no cash out', async () => {
  const biz = await makeBusiness();
  const product = await makeProduct(biz._id, [
    { label: 'M', costPrice: 0, salePrice: 5000, stock: 0 }
  ]);
  const created = await runHandler(createBatch, {
    body: {
      business: String(biz._id),
      product: String(product._id),
      lines: [
        {
          variantId: String(product.variants[0]._id),
          quantity: 12,
          costLines: [{ label: 'Opening stock', amount: 36000, fund: 'opening' }]
        }
      ]
    }
  });
  await runHandler(closeBatch, {
    resource: await ProductionBatch.findById(created.body.data._id),
    body: {}
  });

  const variant = (await Product.findById(product._id)).variants[0];
  assert.equal(variant.stock, 12);
  assert.equal(variant.costPrice, 3000);
  assert.equal(await net(biz, CODES.INVENTORY), 3600000);
  assert.equal(await net(biz, CODES.CASH), 0);
  assert.equal(await net(biz, CODES.OPENING_BALANCES), -3600000);
});

test('material already on the shelf: into Raw materials, no cash out', async () => {
  const biz = await makeBusiness();
  const material = await Material.create({
    business: biz._id,
    name: 'Lace',
    unit: 'metre',
    createdBy: userId
  });
  const out = await runHandler(buyMaterial, {
    resource: material,
    body: materialPurchaseSchema.parse({ quantity: 50, amount: 5000, opening: true })
  });
  assert.equal(out.body.data.paidFrom, 'Already had it (opening)');
  assert.equal((await Material.findById(material._id)).stock, 50);
  assert.equal(await net(biz, CODES.RAW_MATERIALS), 500000);
  assert.equal(await net(biz, CODES.CASH), 0);
  assert.equal(await net(biz, CODES.OPENING_BALANCES), -500000);
});
