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
import MaterialMove from '../models/MaterialMove.js';
import Product from '../models/Product.js';
import ProductionBatch from '../models/ProductionBatch.js';
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { accountBalance, partyBalance } from '../utils/ledger.js';
import {
  createMaterial,
  buyMaterial,
  adjustMaterial,
  undoMaterialMove
} from '../controllers/materialController.js';
import { createBatch, closeBatch, updateBatch } from '../controllers/productionController.js';
import { createOrder, addCustomCost, deleteCustomCost } from '../controllers/orderController.js';
import { recordExpense } from '../controllers/financeController.js';
import { recordPartyTransaction } from '../controllers/partyController.js';
import Order from '../models/Order.js';
import { orderCreateSchema, customCostSchema } from '../schemas/orders.js';
import { partyTransactionSchema } from '../schemas/parties.js';

/**
 * Raw material is stock, not an expense: buying it never touches profit, a batch
 * moves it into the article's cost at the average, and only waste or a short
 * count is a loss. The Raw materials account always equals Σ material values.
 */

before(connect);
after(disconnect);
afterEach(clear);

const admin = { id: userId, role: { fullAccess: true } };
const balance = async (biz, code) =>
  accountBalance(biz._id, (await accountByCode(biz._id, code))._id);

async function setup() {
  const biz = await makeBusiness();
  const made = await runHandler(createMaterial, {
    body: { business: String(biz._id), name: 'Base dye', unit: 'piece' }
  });
  const material = await Material.findById(made.body.data._id);
  return { biz, material };
}

const buy = async (material, quantity, amount, extra = {}) =>
  runHandler(buyMaterial, {
    resource: await Material.findById(material._id),
    body: { quantity, amount, method: 'cash', ...extra }
  });

const reload = m => Material.findById(m._id);

test('buying puts material in stock without touching profit', async () => {
  const { biz, material } = await setup();
  await buy(material, 112, 56000);

  const m = await reload(material);
  assert.equal(m.stock, 112);
  assert.equal(m.valuePaisa, 5600000);
  assert.equal(m.unitCostPaisa, 50000);
  assert.equal(await balance(biz, CODES.RAW_MATERIALS), 5600000);
  assert.equal(await balance(biz, CODES.CASH), -5600000);
  assert.equal(await balance(biz, CODES.RAW_MATERIAL), 0); // no expense
});

test('bought on credit, the supplier is owed', async () => {
  const { biz, material } = await setup();
  const supplier = await makeParty(biz._id, 'supplier');
  await buy(material, 10, 5000, { onCredit: true, party: String(supplier._id) });
  assert.equal(await partyBalance(biz._id, supplier._id), -500000);
});

test('a second purchase re-averages the unit cost', async () => {
  const { material } = await setup();
  await buy(material, 10, 5000); // 500 each
  await buy(material, 10, 7000); // 700 each
  assert.equal((await reload(material)).unitCostPaisa, 60000);
});

/** A batch of 20 suits using `qty` dye plus Rs 10,000 of tailoring. */
async function batchUsing(biz, material, qty) {
  const product = await makeProduct(biz._id, [
    { label: 'M', costPrice: 0, salePrice: 5000, stock: 0 }
  ]);
  const variantId = String(product.variants[0]._id);
  const created = await runHandler(createBatch, {
    body: {
      business: String(biz._id),
      product: String(product._id),
      lines: [
        {
          variantId,
          quantity: 20,
          costLines: [
            { material: String(material._id), materialQty: qty },
            { label: 'Tailor', amount: 10000, fund: 'cash' }
          ]
        }
      ]
    }
  });
  return { product, variantId, batchId: created.body.data._id };
}

test('a draft batch estimates material but takes nothing until it closes', async () => {
  const { biz, material } = await setup();
  await buy(material, 112, 56000);
  const { batchId } = await batchUsing(biz, material, 10);

  const draft = await ProductionBatch.findById(batchId);
  assert.equal(draft.lines[0].costLines[0].label, 'Base dye');
  assert.equal(draft.lines[0].costLines[0].amountPaisa, 500000);
  assert.equal((await reload(material)).stock, 112);
});

test('closing a batch moves material into the article, not into profit', async () => {
  const { biz, material } = await setup();
  await buy(material, 112, 56000);
  const { product, batchId } = await batchUsing(biz, material, 10);
  await runHandler(closeBatch, { resource: await ProductionBatch.findById(batchId), body: {} });

  const m = await reload(material);
  assert.equal(m.stock, 102);
  assert.equal(m.valuePaisa, 5100000);
  assert.equal(await balance(biz, CODES.RAW_MATERIALS), 5100000);
  // 5,000 dye + 10,000 tailoring over 20 suits = 750 each.
  assert.equal(await balance(biz, CODES.INVENTORY), 1500000);
  assert.equal((await Product.findById(product._id)).variants[0].costPrice, 750);

  const moves = await MaterialMove.find({ material: material._id, kind: 'use' });
  assert.equal(moves.length, 1);
  assert.equal(moves[0].quantity, -10);
  assert.equal(String(moves[0].batch), String(batchId));
});

test('a batch can not close on material the store does not have', async () => {
  const { biz, material } = await setup();
  await buy(material, 5, 2500);
  const { batchId } = await batchUsing(biz, material, 10);
  await assert.rejects(
    runHandler(closeBatch, { resource: await ProductionBatch.findById(batchId), body: {} }),
    /Not enough Base dye — only 5 pieces left/
  );
  assert.equal((await reload(material)).stock, 5);
  assert.equal((await ProductionBatch.findById(batchId)).status, 'open');
});

test('a short second material puts the first back', async () => {
  const { biz, material } = await setup();
  await buy(material, 50, 5000);
  const thread = await Material.create({
    business: biz._id,
    name: 'Thread',
    unit: 'cone',
    createdBy: userId
  });
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
          quantity: 5,
          costLines: [
            { material: String(material._id), materialQty: 10 },
            { material: String(thread._id), materialQty: 3 }
          ]
        }
      ]
    }
  });
  await assert.rejects(
    runHandler(closeBatch, {
      resource: await ProductionBatch.findById(created.body.data._id),
      body: {}
    }),
    /Not enough Thread/
  );
  const m = await reload(material);
  assert.equal(m.stock, 50);
  assert.equal(m.valuePaisa, 500000);
});

test('the last unit out takes exactly the value left', async () => {
  const { biz, material } = await setup();
  await buy(material, 3, 100); // 33.33 each — does not divide evenly
  const { batchId } = await batchUsing(biz, material, 3);
  await runHandler(closeBatch, { resource: await ProductionBatch.findById(batchId), body: {} });
  const m = await reload(material);
  assert.equal(m.stock, 0);
  assert.equal(m.valuePaisa, 0);
  assert.equal(await balance(biz, CODES.RAW_MATERIALS), 0);
});

test('waste and a short count are losses; a count that finds more is a gain', async () => {
  const { biz, material } = await setup();
  await buy(material, 100, 10000); // 100 each

  const adjust = async body =>
    runHandler(adjustMaterial, { resource: await reload(material), body });
  await adjust({ kind: 'wasted', quantity: 2 });
  assert.equal(await balance(biz, CODES.MATERIAL_LOSS), 20000);

  await adjust({ kind: 'count', quantity: 95 }); // 98 → 95
  assert.equal(await balance(biz, CODES.MATERIAL_LOSS), 50000);

  await adjust({ kind: 'count', quantity: 96 }); // found one
  assert.equal(await balance(biz, CODES.MATERIAL_LOSS), 40000);

  const m = await reload(material);
  assert.equal(m.stock, 96);
  assert.equal(await balance(biz, CODES.RAW_MATERIALS), m.valuePaisa);
  await assert.rejects(adjust({ kind: 'count', quantity: 96 }), /The count matches/);
});

test('only the latest purchase can be undone, and a batch use never here', async () => {
  const { biz, material } = await setup();
  await buy(material, 10, 1000);
  const second = await buy(material, 5, 1000);
  const first = await MaterialMove.findOne({
    material: material._id,
    kind: 'purchase',
    quantity: 10
  });

  const undo = async moveId =>
    runHandler(undoMaterialMove, {
      resource: await reload(material),
      params: { moveId: String(moveId) }
    });
  await assert.rejects(undo(first._id), /Only the latest/);

  await undo(second.body.data._id);
  const m = await reload(material);
  assert.equal(m.stock, 10);
  assert.equal(m.valuePaisa, 100000);
  assert.equal(await balance(biz, CODES.RAW_MATERIALS), 100000);
  assert.equal(await balance(biz, CODES.CASH), -100000);

  const { batchId } = await batchUsing(biz, material, 4);
  await runHandler(closeBatch, { resource: await ProductionBatch.findById(batchId), body: {} });
  const use = await MaterialMove.findOne({ material: material._id, kind: 'use' });
  await assert.rejects(undo(use._id), /used by a batch/);
});

test('correcting a closed batch keeps its material as it was', async () => {
  const { biz, material } = await setup();
  await buy(material, 100, 10000);
  const { variantId, batchId } = await batchUsing(biz, material, 10);
  await runHandler(closeBatch, { resource: await ProductionBatch.findById(batchId), body: {} });

  const correct = async costLines =>
    runHandler(updateBatch, {
      user: admin,
      resource: await ProductionBatch.findById(batchId),
      body: { lines: [{ variantId, quantity: 20, costLines }] }
    });

  await assert.rejects(
    correct([
      { material: String(material._id), materialQty: 12 },
      { label: 'Tailor', amount: 10000, fund: 'cash' }
    ]),
    /material a closed batch used can not be changed/
  );

  await correct([
    { material: String(material._id), materialQty: 10 },
    { label: 'Tailor', amount: 12000, fund: 'cash' }
  ]);
  // Material stays taken once: 100 − 10, and its account unchanged by the correction.
  assert.equal((await reload(material)).stock, 90);
  assert.equal(await balance(biz, CODES.RAW_MATERIALS), 900000);
  assert.equal(await balance(biz, CODES.INVENTORY), 1300000);
});

// ── Counted once: material and tailoring never go to an everyday expense ──

test('a shop expense or a supplier bill for material or tailoring is refused', async () => {
  const { biz } = await setup();
  const supplier = await makeParty(biz._id, 'supplier');
  for (const category of [CODES.RAW_MATERIAL, CODES.TAILORING]) {
    await assert.rejects(
      runHandler(recordExpense, {
        body: { business: String(biz._id), amount: 1000, category, method: 'cash' }
      }),
      /counted once/
    );
    await assert.rejects(
      runHandler(recordPartyTransaction, {
        resource: supplier,
        body: partyTransactionSchema.parse({ direction: 'got', amount: 1000, category })
      }),
      /counted once/
    );
  }
});

// ── Custom work on an order, from the store ──

async function customOrder(biz) {
  const product = await makeProduct(biz._id);
  const body = orderCreateSchema.parse({
    business: String(biz._id),
    customerName: 'Hina',
    contactNumber: '03001112222',
    items: [
      {
        product: String(product._id),
        variantId: String(product.variants[0]._id),
        quantity: 1,
        unitPrice: 3000
      }
    ],
    customWork: [{ description: 'Add lace', price: 800 }]
  });
  const out = await runHandler(createOrder, { body });
  return Order.findById(out.body.data._id);
}

test('custom work takes material from the store at the average, and removing puts it back', async () => {
  const { biz, material } = await setup();
  await buy(material, 20, 2000); // 100 each
  const order = await customOrder(biz);

  await runHandler(addCustomCost, {
    resource: order,
    body: customCostSchema.parse({ material: String(material._id), materialQty: 3 })
  });
  const saved = await Order.findById(order._id);
  assert.equal(saved.customCosts[0].amountPaisa, 30000);
  assert.equal(saved.customCosts[0].description, 'Base dye × 3 pieces');
  assert.equal((await reload(material)).stock, 17);
  assert.equal(await balance(biz, CODES.CUSTOM_WIP), 30000);
  assert.equal(await balance(biz, CODES.RAW_MATERIALS), 170000);
  assert.equal(await balance(biz, CODES.CASH), -200000); // no second payment
  assert.ok(await MaterialMove.exists({ material: material._id, kind: 'use', order: order._id }));

  await runHandler(deleteCustomCost, {
    resource: saved,
    params: { costId: String(saved.customCosts[0]._id) }
  });
  const m = await reload(material);
  assert.equal(m.stock, 20);
  assert.equal(m.valuePaisa, 200000);
  assert.equal(await balance(biz, CODES.CUSTOM_WIP), 0);
  assert.equal(await balance(biz, CODES.RAW_MATERIALS), 200000);
  assert.equal(await MaterialMove.countDocuments({ kind: 'use' }), 0);
});

test('custom work can not take more material than the store has', async () => {
  const { biz, material } = await setup();
  await buy(material, 2, 200);
  const order = await customOrder(biz);
  await assert.rejects(
    runHandler(addCustomCost, {
      resource: order,
      body: customCostSchema.parse({ material: String(material._id), materialQty: 3 })
    }),
    /Not enough Base dye/
  );
  assert.equal((await reload(material)).stock, 2);
});
