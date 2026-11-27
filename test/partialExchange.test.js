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
import Product from '../models/Product.js';
import JournalEntry from '../models/JournalEntry.js';
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { accountBalance, trialBalance } from '../utils/ledger.js';
import {
  createOrder,
  updateOrderStatus,
  exchangeReturn,
  createReplacement,
  swapOrder,
  receiveReturn,
  getExchangeQuote
} from '../controllers/orderController.js';
import {
  orderCreateSchema,
  orderStatusSchema,
  orderExchangeReturnSchema,
  orderReplacementSchema,
  orderSwapSchema
} from '../schemas/orders.js';

/**
 * Exchange only SOME of an order's items. The owner's case: order #0204 held two items (Rs 25,000); the customer swapped
 * one of them (16,000 → 16,000) and kept the other. The credit is THAT item's price, the rest stays sold and Delivered,
 * and the swap customer pays the new parcel's courier cost — handing over a little more is the shop's delivery income.
 */
before(connect);
after(disconnect);
afterEach(clear);

let seq = 0;

async function setup() {
  const biz = await makeBusiness();
  const product = await makeProduct(biz._id, [
    { label: 'M', costPrice: 1000, salePrice: 3000, stock: 10 },
    { label: 'L', costPrice: 1000, salePrice: 3000, stock: 10 },
    { label: 'S', costPrice: 1000, salePrice: 3000, stock: 10 }
  ]);
  const courier = await makeParty(biz._id, 'courier');
  const acc = async code => (await accountByCode(biz._id, code))._id;
  return { biz, product, courier, cash: String(await acc(CODES.CASH)), acc };
}

const variantId = (ctx, label) => String(ctx.product.variants.find(v => v.label === label)._id);
const item = (ctx, label, price) => ({
  product: String(ctx.product._id),
  variantId: variantId(ctx, label),
  quantity: 1,
  unitPrice: price
});

const setStatus = (order, body) =>
  runHandler(updateOrderStatus, { resource: order, body: orderStatusSchema.parse(body) }).then(r =>
    Order.findById(r.body.data._id)
  );

/** Order #0204: M at 16,000 and L at 9,000, delivered with a 268.25 delivery charge. */
async function shakira(ctx) {
  seq += 1;
  const out = await runHandler(createOrder, {
    body: orderCreateSchema.parse({
      business: String(ctx.biz._id),
      customerName: 'Shakira Bano',
      contactNumber: '03001112222',
      items: [item(ctx, 'M', 16000), item(ctx, 'L', 9000)]
    })
  });
  let order = await Order.findById(out.body.data._id);
  order = await setStatus(order, {
    status: 'dispatched',
    courier: String(ctx.courier._id),
    trackingId: `TRK${seq}`
  });
  return setStatus(order, { status: 'delivered', deliveryCharge: 268.25 });
}

const stockOf = async (ctx, label) =>
  (await Product.findById(ctx.product._id)).variants.find(v => v.label === label).stock;
const bal = async (ctx, code) => accountBalance(ctx.biz._id, await ctx.acc(code));
const lineOf = (order, index) => String(order.items[index]._id);

async function everyEntryBalances(ctx) {
  for (const e of await JournalEntry.find({ business: ctx.biz._id })) {
    const debit = e.lines.reduce((s, l) => s + l.debitPaisa, 0);
    const credit = e.lines.reduce((s, l) => s + l.creditPaisa, 0);
    assert.equal(debit, credit, `"${e.memo}" balances`);
  }
  assert.equal((await trialBalance(ctx.biz._id)).balanced, true);
}

const swap = (ctx, original, body) =>
  runHandler(swapOrder, {
    resource: original,
    body: orderSwapSchema.parse({ differenceAccount: ctx.cash, ...body })
  }).then(r => Order.findById(r.body.data._id));

test('Shakira: swap one of two items for the same price — credit 16,000, pays the courier cost, extra is delivery income', async () => {
  const ctx = await setup();
  const original = await shakira(ctx);
  assert.equal(original.total, 25000);
  const mBefore = await stockOf(ctx, 'M');
  const sBefore = await stockOf(ctx, 'S');

  const replacement = await swap(ctx, original, {
    lines: [{ line: lineOf(original, 0), quantity: 1 }],
    items: [item(ctx, 'S', 16000)],
    amountReceived: 500
  });

  // The replacement is its price, paid: 16,000 credit + 268.25 advance − 268.25 kept for the courier.
  assert.equal(replacement.total, 16000);
  assert.equal(replacement.codAmount, 0, 'the rider collects nothing');
  assert.equal(replacement.isSwap, true);
  const advance = replacement.customerMoney.find(m => m.kind === 'advance');
  assert.equal(advance.amountPaisa, 26825, 'what was due: the new parcel’s delivery charge');
  assert.equal(replacement.customerMoney.find(m => m.kind === 'transfer-in').amountPaisa, 1600000);

  // She handed over 500: the 231.75 beyond the courier’s cost is the shop’s, delivery income.
  assert.equal(await bal(ctx, CODES.CASH), 50000);
  assert.equal(await bal(ctx, CODES.DELIVERY_INCOME), -23175);
  assert.equal(await bal(ctx, CODES.CHARGES_KEPT), -26825);
  assert.ok(replacement.activity.some(a => /Extra delivery charge/.test(a.text)));

  // The original is untouched except for the swapped item: still Delivered, the other item kept and sold.
  const fresh = await Order.findById(original._id);
  assert.equal(fresh.status, 'delivered');
  assert.equal(fresh.exchangedFor, undefined, 'only part of it was exchanged');
  assert.equal(fresh.refundDuePaisa, 0, 'nothing owed back: the credit moved to the replacement');
  assert.equal(fresh.awaitingReturn, true);
  assert.equal(fresh.returnedItems.length, 1);
  assert.equal(fresh.returnedItems[0].forExchange, true);
  assert.equal(fresh.returnedItems[0].stockPending, true);
  assert.equal(String(fresh.returnedItems[0].replacement), String(replacement._id));

  // The new piece left the shelf now; the old one returns only when it arrives.
  assert.equal(await stockOf(ctx, 'S'), sBefore - 1);
  assert.equal(await stockOf(ctx, 'M'), mBefore);
  await runHandler(receiveReturn, { resource: fresh, body: {} });
  assert.equal(await stockOf(ctx, 'M'), mBefore + 1);
  assert.equal(await stockOf(ctx, 'L'), 10 - 1, 'the kept item was never put back');
  const arrived = await Order.findById(original._id);
  assert.equal(arrived.awaitingReturn, false);
  assert.equal(arrived.returnedItems[0].stockPending, undefined);
  await everyEntryBalances(ctx);
});

test('the quote for some items: credit is just their price, and it says what the customer pays', async () => {
  const ctx = await setup();
  const original = await shakira(ctx);
  const quote = async query =>
    (await runHandler(getExchangeQuote, { resource: original, query })).body.data;

  const some = await quote({
    total: '16000',
    swap: 'true',
    lines: `${lineOf(original, 0)}:1`
  });
  assert.equal(some.isPartial, true);
  assert.equal(some.credit, 16000);
  assert.equal(some.pays, 268.25);
  assert.equal(some.difference, 0);

  const whole = await quote({ total: '16000', swap: 'true' });
  assert.equal(whole.isPartial, false);
  assert.equal(whole.credit, 25000, 'the whole order, as before');

  const free = await quote({
    total: '16000',
    swap: 'true',
    lines: `${lineOf(original, 0)}:1`,
    free: 'true'
  });
  assert.equal(free.owes, false, 'free delivery and the same price: nothing to pay');

  await assert.rejects(
    runHandler(getExchangeQuote, {
      resource: original,
      query: { total: '16000', lines: `${lineOf(original, 0)}:5` }
    }),
    /Only 1 of/
  );
  await assert.rejects(
    runHandler(getExchangeQuote, { resource: original, query: { total: '16000', lines: 'x:y' } }),
    /Choose which items/
  );
});

test('handing over less than is due is refused with nothing posted; free delivery lets the price difference be all', async () => {
  const ctx = await setup();
  const original = await shakira(ctx);
  const lines = [{ line: lineOf(original, 0), quantity: 1 }];
  const entries = await JournalEntry.countDocuments();
  const sBefore = await stockOf(ctx, 'S');

  await assert.rejects(
    swap(ctx, original, { lines, items: [item(ctx, 'S', 16000)], amountReceived: 100 }),
    /less than the Rs 268.25 due — choose Free delivery/
  );
  assert.equal(await JournalEntry.countDocuments(), entries, 'nothing posted');
  assert.equal(await stockOf(ctx, 'S'), sBefore, 'no stock taken');
  assert.equal((await Order.findById(original._id)).returnedItems.length, 0);

  // Free: the customer pays only the 1,000 difference; the shop absorbs the courier, and the reason is kept.
  const free = await swap(ctx, original, {
    lines,
    items: [item(ctx, 'S', 17000)],
    freeCourier: true,
    freeReason: 'faulty piece',
    amountReceived: 1000
  });
  assert.equal(free.customerMoney.find(m => m.kind === 'advance').amountPaisa, 100000);
  assert.equal(
    free.customerMoney.filter(m => m.kind === 'kept').length,
    0,
    'nothing kept for the courier'
  );
  assert.equal(free.courierCosts.waived, true);
  assert.equal(free.courierCosts.reason, 'faulty piece');
  assert.ok(free.activity.some(a => /Delivery made free — faulty piece/.test(a.text)));
  assert.equal(await bal(ctx, CODES.DELIVERY_INCOME), 0);
  await everyEntryBalances(ctx);

  // A free delivery with no reason is refused by the schema.
  assert.throws(() => orderSwapSchema.parse({ items: [item(ctx, 'S', 1)], freeCourier: true }));
});

test('return first, some items: the credit is that item’s price, and a cheaper replacement is owed the difference', async () => {
  const ctx = await setup();
  const original = await shakira(ctx);
  const mBefore = await stockOf(ctx, 'M');

  const back = await runHandler(exchangeReturn, {
    resource: original,
    body: orderExchangeReturnSchema.parse({
      lines: [{ line: lineOf(original, 0), quantity: 1 }],
      returnCourierName: 'TCS',
      reversalTrackingId: 'REV-1'
    })
  }).then(r => Order.findById(r.body.data._id));
  assert.equal(back.status, 'delivered', 'only part of it came back');
  assert.equal(await stockOf(ctx, 'M'), mBefore + 1, 'the item is back on the shelf now');
  assert.equal(back.refundDuePaisa, 1600000, 'its credit waits for a replacement');
  assert.equal(back.returnedItems[0].forExchange, true);
  assert.equal(back.returnedItems[0].stockPending, undefined);

  const replacement = await runHandler(createReplacement, {
    resource: back,
    body: orderReplacementSchema.parse({ items: [item(ctx, 'S', 12000)] })
  }).then(r => Order.findById(r.body.data._id));
  assert.equal(replacement.codAmount, 0);
  assert.equal(
    replacement.refundDuePaisa,
    400000,
    'held gross until PostEx has billed the new parcel'
  );
  assert.equal(replacement.exchangeCostRule, 'new-parcel');

  const after = await Order.findById(original._id);
  assert.equal(after.refundDuePaisa, 0, 'the credit moved');
  assert.equal(String(after.returnedItems[0].replacement), String(replacement._id));
  assert.equal(after.exchangedFor, undefined);
  await assert.rejects(
    runHandler(createReplacement, {
      resource: after,
      body: orderReplacementSchema.parse({ items: [item(ctx, 'S', 1)] })
    }),
    /Record the item coming back first/
  );
  await everyEntryBalances(ctx);
});

test('every piece in the lines is the whole-order exchange it always was', async () => {
  const ctx = await setup();
  const original = await shakira(ctx);
  const out = await runHandler(exchangeReturn, {
    resource: original,
    body: orderExchangeReturnSchema.parse({
      lines: [
        { line: lineOf(original, 0), quantity: 1 },
        { line: lineOf(original, 1), quantity: 1 }
      ]
    })
  }).then(r => Order.findById(r.body.data._id));
  assert.equal(out.status, 'exchanged');
  assert.equal(out.returnedItems.length, 0, 'no partial rows: the whole order');
  assert.equal(out.refundDuePaisa, 2500000);
});

test('the rest of the order can be exchanged later; more than is left is refused', async () => {
  const ctx = await setup();
  const original = await shakira(ctx);
  await swap(ctx, original, {
    lines: [{ line: lineOf(original, 0), quantity: 1 }],
    items: [item(ctx, 'S', 16000)]
  });

  const again = await Order.findById(original._id);
  await assert.rejects(
    swap(ctx, again, {
      lines: [{ line: lineOf(original, 0), quantity: 1 }],
      items: [item(ctx, 'S', 1)]
    }),
    /has already been sent back/
  );
  const second = await swap(ctx, again, {
    lines: [{ line: lineOf(original, 1), quantity: 1 }],
    items: [item(ctx, 'S', 9000)]
  });
  assert.equal(second.total, 9000);
  const done = await Order.findById(original._id);
  assert.equal(done.returnedItems.length, 2);
  assert.equal(done.returnedPieces, 2);
  assert.equal(done.status, 'delivered');
  await everyEntryBalances(ctx);
});

test('a counter sale or an order not yet delivered can not be exchanged in part', async () => {
  const ctx = await setup();
  seq += 1;
  const out = await runHandler(createOrder, {
    body: orderCreateSchema.parse({
      business: String(ctx.biz._id),
      customerName: 'Sana',
      contactNumber: '03004445555',
      items: [item(ctx, 'M', 1000), item(ctx, 'L', 1000)]
    })
  });
  const created = await Order.findById(out.body.data._id);
  await assert.rejects(
    swap(ctx, created, {
      lines: [{ line: lineOf(created, 0), quantity: 1 }],
      items: [item(ctx, 'S', 1000)]
    }),
    /Only a delivered order/
  );
});
