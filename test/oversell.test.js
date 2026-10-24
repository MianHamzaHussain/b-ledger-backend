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
import Product from '../models/Product.js';
import Order from '../models/Order.js';
import '../models/Category.js'; // the create response populates it
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { accountBalance } from '../utils/ledger.js';
import { reserveStock } from '../utils/stock.js';
import { createOrder, updateOrderStatus } from '../controllers/orderController.js';
import { createProduct } from '../controllers/productController.js';
import { createGoodsReceipt } from '../controllers/goodsReceiptController.js';
import { orderCreateSchema, orderStatusSchema } from '../schemas/orders.js';
import { goodsReceiptCreateSchema } from '../schemas/goodsReceipts.js';
import { businessCreateSchema, businessUpdateSchema } from '../schemas/businesses.js';

/**
 * An article can keep selling when out of stock: customer orders are taken, stock
 * goes below zero (what customers are still owed), and the next arrival fills
 * those orders first — 10 sold with none on the shelf, then 12 arrive, leaves 2.
 * Everything else keeps the old rule: refused when short.
 */

before(connect);
after(disconnect);
afterEach(clear);

const admin = { id: userId, role: { fullAccess: true } };

async function setup({ allowOversell = true, stock = 0 } = {}) {
  const biz = await makeBusiness();
  const product = await makeProduct(biz._id, [
    { label: 'M', costPrice: 1000, salePrice: 3000, stock }
  ]);
  if (allowOversell) await Product.updateOne({ _id: product._id }, { allowOversell: true });
  const courier = await makeParty(biz._id, 'courier');
  const supplier = await makeParty(biz._id, 'supplier');
  return { biz, product, courier, supplier };
}

const stockOf = async ctx => (await Product.findById(ctx.product._id)).variants[0].stock;

const order = async (ctx, quantity) => {
  const out = await runHandler(createOrder, {
    body: orderCreateSchema.parse({
      business: String(ctx.biz._id),
      customerName: 'Sana',
      contactNumber: '03004445555',
      items: [
        {
          product: String(ctx.product._id),
          variantId: String(ctx.product.variants[0]._id),
          quantity,
          unitPrice: 3000
        }
      ]
    })
  });
  return Order.findById(out.body.data._id);
};

const setStatus = (o, body) =>
  runHandler(updateOrderStatus, { resource: o, body: orderStatusSchema.parse(body) }).then(r =>
    Order.findById(r.body.data._id)
  );

const deliver = async (ctx, o) => {
  o = await setStatus(o, {
    status: 'dispatched',
    courier: String(ctx.courier._id),
    trackingId: 'TRK1'
  });
  return setStatus(o, { status: 'delivered' });
};

const receive = (ctx, quantity, unitCost = 1200) =>
  runHandler(createGoodsReceipt, {
    user: admin,
    body: goodsReceiptCreateSchema.parse({
      business: String(ctx.biz._id),
      party: String(ctx.supplier._id),
      lines: [
        {
          product: String(ctx.product._id),
          variantId: String(ctx.product.variants[0]._id),
          quantity,
          unitCost
        }
      ]
    })
  });

test('an article that does not keep selling still refuses an order that is too big', async () => {
  const ctx = await setup({ allowOversell: false, stock: 3 });
  await assert.rejects(order(ctx, 5), /Not enough stock/);
  assert.equal(await stockOf(ctx), 3);
  assert.equal(await Order.countDocuments(), 0);
});

test('the refusal tells staff how to take the order anyway', async () => {
  const ctx = await setup({ allowOversell: false, stock: 0 });
  await assert.rejects(order(ctx, 1), /Keep selling when out of stock/);
});

test('an article that keeps selling takes an order with nothing on the shelf', async () => {
  const ctx = await setup();
  const o = await order(ctx, 10);
  assert.equal(await stockOf(ctx), -10);
  assert.equal(o.items[0].oversold, 10);
  assert.equal((await Product.findById(ctx.product._id)).totalStock, -10);
});

test('only the missing pieces count as sold without stock', async () => {
  const ctx = await setup({ stock: 3 });
  const o = await order(ctx, 5);
  assert.equal(await stockOf(ctx), -2);
  assert.equal(o.items[0].oversold, 2);
});

test('two orders racing on an article that keeps selling both land, and stock is the sum', async () => {
  const ctx = await setup({ stock: 2 });
  const results = await Promise.allSettled([order(ctx, 3), order(ctx, 4)]);
  assert.deepEqual(
    results.map(r => r.status),
    ['fulfilled', 'fulfilled']
  );
  assert.equal(await stockOf(ctx), -5);
});

test('new stock fills the orders first: 10 sold with none, 12 arrive, 2 are left', async () => {
  const ctx = await setup();
  await order(ctx, 10);
  await receive(ctx, 12);
  const variant = (await Product.findById(ctx.product._id)).variants[0];
  assert.equal(variant.stock, 2);
  // Nothing was on the shelf, so the average is the new batch's cost, not a blend with minus pieces.
  assert.equal(variant.costPrice, 1200);
});

test('cancelling a sold-without-stock order puts all of its pieces back', async () => {
  const ctx = await setup();
  const o = await order(ctx, 10);
  await setStatus(o, { status: 'cancelled' });
  assert.equal(await stockOf(ctx), 0);
});

test('delivered after stock arrived: the cost of goods uses the new cost, not 0', async () => {
  const ctx = await setup();
  const o = await order(ctx, 2);
  assert.equal(o.items[0].unitCost, 1000, 'snapshot taken at order time');
  await Product.updateOne({ _id: ctx.product._id }, { 'variants.0.costPrice': 1500 });
  const delivered = await deliver(ctx, o);
  assert.equal(delivered.items[0].unitCost, 1500);
  assert.equal(delivered.items[0].costUnknown, false);
  const cogs = await accountByCode(ctx.biz._id, CODES.COGS);
  assert.equal(await accountBalance(ctx.biz._id, cogs._id), 2 * 1500 * 100);
});

test('delivered with no cost known yet is flagged, not guessed', async () => {
  const ctx = await setup();
  await Product.updateOne({ _id: ctx.product._id }, { 'variants.0.costPrice': 0 });
  const o = await order(ctx, 2);
  const delivered = await deliver(ctx, o);
  assert.equal(delivered.items[0].unitCost, 0);
  assert.equal(delivered.items[0].costUnknown, true);
});

test('a handover (reserve without the opt-in) never oversells, even on an article that does', async () => {
  const ctx = await setup({ stock: 1 });
  const items = [
    {
      product: ctx.product._id,
      variantId: ctx.product.variants[0]._id,
      quantity: 2,
      productName: 'Test Product'
    }
  ];
  await assert.rejects(reserveStock(items), /Not enough stock/);
  assert.equal(await stockOf(ctx), 1);
});

test('a product can still be saved while its stock is below zero', async () => {
  const ctx = await setup();
  await order(ctx, 4);
  const product = await Product.findById(ctx.product._id);
  product.name = 'Renamed';
  await product.save(); // used to fail: "Stock can not be negative"
  assert.equal((await Product.findById(ctx.product._id)).variants[0].stock, -4);
});

test('a new article starts from its business default, unless it says otherwise', async () => {
  const biz = await makeBusiness();
  const base = {
    business: biz._id,
    category: biz.category,
    name: 'Lawn Suit',
    createdBy: userId,
    variants: [{ label: 'M', salePrice: 3000 }]
  };
  const make = body => runHandler(createProduct, { body }).then(r => r.body.data);

  assert.equal((await make({ ...base })).allowOversell, false, 'default is off');
  await (
    await import('../models/Business.js')
  ).default.updateOne({ _id: biz._id }, { defaultAllowOversell: true });
  assert.equal((await make({ ...base, name: 'Two' })).allowOversell, true, 'business default');
  assert.equal(
    (await make({ ...base, name: 'Three', allowOversell: false })).allowOversell,
    false,
    'an explicit choice wins'
  );
});

test('the business default survives request validation (an unknown key would be stripped)', () => {
  const body = { name: 'B', category: 'c', defaultAllowOversell: true };
  assert.equal(businessCreateSchema.parse(body).defaultAllowOversell, true);
  assert.equal(
    businessUpdateSchema.parse({ defaultAllowOversell: false }).defaultAllowOversell,
    false
  );
});
