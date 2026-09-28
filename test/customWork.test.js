import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  connect,
  clear,
  disconnect,
  makeBusiness,
  makeProduct,
  makeParty,
  runHandler
} from './helpers/db.js';
import Order from '../models/Order.js';
import JournalEntry from '../models/JournalEntry.js';
import { orderCreateSchema, orderStatusSchema } from '../schemas/orders.js';
import { createOrder, updateOrderStatus, addCustomCost } from '../controllers/orderController.js';
import { toPaisa } from '../utils/money.js';
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { accountBalance } from '../utils/ledger.js';
import { reverseJournalEntry } from '../controllers/financeController.js';

before(connect);
after(disconnect);
afterEach(clear);

async function setup() {
  const biz = await makeBusiness();
  const product = await makeProduct(biz._id);
  const courier = await makeParty(biz._id, 'courier');
  const acc = async code => (await accountByCode(biz._id, code))._id;
  return {
    biz,
    product,
    courier,
    cash: String(await acc(CODES.CASH)),
    bank: String(await acc(CODES.BANK)),
    liability: await acc(CODES.CUSTOMER_ADVANCES)
  };
}

const newOrder = async (ctx, extra = {}) => {
  const body = orderCreateSchema.parse({
    business: String(ctx.biz._id),
    customerName: 'Hina',
    contactNumber: '03001112222',
    items: [
      {
        product: String(ctx.product._id),
        variantId: String(ctx.product.variants[0]._id),
        quantity: 1,
        unitPrice: 3000
      }
    ],
    ...extra
  });
  const out = await runHandler(createOrder, { body });
  return Order.findById(out.body.data._id);
};

const setStatus = (order, body) =>
  runHandler(updateOrderStatus, { resource: order, body: orderStatusSchema.parse(body) }).then(r =>
    Order.findById(r.body.data._id)
  );

test('an item plus custom work of 500: the total is 3,500 and the COD is 3,500', async () => {
  const ctx = await setup();
  const order = await newOrder(ctx, {
    customWork: [{ description: 'Shorten sleeves', price: 500 }]
  });

  assert.equal(order.total, 3500);
  assert.equal(order.codAmount, 3500);
  assert.equal(order.items.length, 1);
  assert.equal(order.customWork.length, 1);
});

test('custom work only: the order is created, the total is 18,000, and stock is unchanged', async () => {
  const ctx = await setup();
  const order = await newOrder(ctx, {
    items: [],
    customWork: [{ description: 'Bridal lehenga', price: 18000, fromScratch: true }]
  });

  assert.equal(order.total, 18000);
  assert.equal(order.items.length, 0);
  assert.equal(order.customWork.length, 1);

  const product = await ctx.product.constructor.findById(ctx.product._id);
  assert.equal(product.variants[0].stock, 50, 'stock is unchanged');
});

test('neither items nor custom work is rejected', async () => {
  const ctx = await setup();
  const res = orderCreateSchema.safeParse({
    business: String(ctx.biz._id),
    customerName: 'Hina',
    contactNumber: '03001112222',
    items: [],
    customWork: []
  });

  assert.equal(res.success, false);
  assert.match(res.error.issues[0].message, /Add at least one item or custom work/);
});

test('deliver an order that has custom work credits Sales with the full total', async () => {
  const ctx = await setup();
  let order = await newOrder(ctx, {
    customWork: [{ description: 'Shorten sleeves', price: 500 }]
  });

  order = await setStatus(order, {
    status: 'dispatched',
    courier: String(ctx.courier._id),
    trackingId: '123'
  });
  order = await setStatus(order, { status: 'delivered', deliveryCharge: 200 });

  const saleEntry = await JournalEntry.findById(order.saleEntry);
  const salesAcc = await accountByCode(ctx.biz._id, CODES.SALES);
  const salesLine = saleEntry.lines.find(l => String(l.account) === String(salesAcc._id));

  assert.equal(salesLine.creditPaisa, toPaisa(3500));
});

test('a cost added to a pending order shows up in customCosts and posts Dr CUSTOM_WIP / Cr Cash', async () => {
  const ctx = await setup();
  let order = await newOrder(ctx, {
    customWork: [{ description: 'Shorten sleeves', price: 500 }]
  });

  await runHandler(addCustomCost, {
    resource: order,
    body: { description: 'Lace', amount: 300, account: ctx.cash }
  });
  order = await Order.findById(order._id);

  assert.equal(order.customCosts.length, 1);
  assert.equal(order.customCosts[0].description, 'Lace');
  assert.equal(order.customCosts[0].amountPaisa, toPaisa(300));

  const entry = await JournalEntry.findById(order.customCosts[0].entry);
  const wipAcc = await accountByCode(ctx.biz._id, CODES.CUSTOM_WIP);
  const wipLine = entry.lines.find(l => String(l.account) === String(wipAcc._id));
  const cashLine = entry.lines.find(l => String(l.account) === String(ctx.cash));

  assert.equal(wipLine.debitPaisa, toPaisa(300));
  assert.equal(cashLine.creditPaisa, toPaisa(300));
});

test('delivering that order moves that exact amount from CUSTOM_WIP to COGS', async () => {
  const ctx = await setup();
  let order = await newOrder(ctx, {
    customWork: [{ description: 'Shorten sleeves', price: 500 }]
  });

  await runHandler(addCustomCost, {
    resource: order,
    body: { description: 'Lace', amount: 300, account: ctx.cash }
  });
  order = await Order.findById(order._id);

  order = await setStatus(order, {
    status: 'dispatched',
    courier: String(ctx.courier._id),
    trackingId: '123'
  });
  order = await setStatus(order, { status: 'delivered', deliveryCharge: 200 });

  const entries = await JournalEntry.find({
    'source.ref': String(order._id),
    memo: { $regex: 'Custom WIP to COGS' }
  });
  assert.equal(entries.length, 1);

  const cogsAcc = await accountByCode(ctx.biz._id, CODES.COGS);
  const wipAcc = await accountByCode(ctx.biz._id, CODES.CUSTOM_WIP);
  const cogsLine = entries[0].lines.find(l => String(l.account) === String(cogsAcc._id));
  const wipLine = entries[0].lines.find(l => String(l.account) === String(wipAcc._id));

  assert.equal(cogsLine.debitPaisa, toPaisa(300));
  assert.equal(wipLine.creditPaisa, toPaisa(300));
});

test('cancelling the order instead moves it to CUSTOM_WRITE_OFF', async () => {
  const ctx = await setup();
  let order = await newOrder(ctx, {
    customWork: [{ description: 'Shorten sleeves', price: 500 }]
  });

  await runHandler(addCustomCost, {
    resource: order,
    body: { description: 'Lace', amount: 300, account: ctx.cash }
  });
  order = await Order.findById(order._id);

  order = await setStatus(order, { status: 'cancelled' });

  assert.ok(order.customCostWriteOff);
  const entry = await JournalEntry.findById(order.customCostWriteOff);

  const writeOffAcc = await accountByCode(ctx.biz._id, CODES.CUSTOM_WRITE_OFF);
  const wipAcc = await accountByCode(ctx.biz._id, CODES.CUSTOM_WIP);
  const writeOffLine = entry.lines.find(l => String(l.account) === String(writeOffAcc._id));
  const wipLine = entry.lines.find(l => String(l.account) === String(wipAcc._id));

  assert.equal(writeOffLine.debitPaisa, toPaisa(300));
  assert.equal(wipLine.creditPaisa, toPaisa(300));
});

test('reopening a cancelled order undoes the write-off', async () => {
  const ctx = await setup();
  let order = await newOrder(ctx, {
    customWork: [{ description: 'Shorten sleeves', price: 500 }]
  });
  await runHandler(addCustomCost, {
    resource: order,
    body: { description: 'Lace', amount: 300, account: ctx.cash }
  });
  order = await Order.findById(order._id);
  order = await setStatus(order, { status: 'cancelled' });
  order = await setStatus(order, { status: 'pending' });

  const wip = await accountByCode(ctx.biz._id, CODES.CUSTOM_WIP);
  const writeOff = await accountByCode(ctx.biz._id, CODES.CUSTOM_WRITE_OFF);
  assert.equal(order.customCostWriteOff, undefined);
  assert.equal(await accountBalance(ctx.biz._id, writeOff._id), 0);
  assert.equal(await accountBalance(ctx.biz._id, wip._id), toPaisa(300), 'material held again');
});

test('a material cost entry is undone on its order, never from the journal', async () => {
  const ctx = await setup();
  const order = await newOrder(ctx, {
    customWork: [{ description: 'Shorten sleeves', price: 500 }]
  });
  const out = await runHandler(addCustomCost, {
    resource: order,
    body: { description: 'Lace', amount: 300, account: ctx.cash }
  });
  const entry = await JournalEntry.findById(out.body.data.customCosts[0].entry);
  await assert.rejects(
    runHandler(reverseJournalEntry, { resource: entry, body: {} }),
    /from its order/
  );
});
