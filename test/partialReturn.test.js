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
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { accountBalance } from '../utils/ledger.js';
import {
  createOrder,
  updateOrderStatus,
  addOrderRefund,
  partialReturnOrder,
  refundReturnOrder,
  exchangeReturn
} from '../controllers/orderController.js';
import {
  orderCreateSchema,
  orderStatusSchema,
  orderMoneySchema,
  orderPartialReturnSchema,
  orderRefundReturnSchema
} from '../schemas/orders.js';
import { returnableLines } from '../utils/partialReturn.js';
import JournalEntry from '../models/JournalEntry.js';

/**
 * The customer kept some pieces of a delivered order and sent the others back (R9-13). Only those pieces
 * go back to stock; their cost and their sale are reversed; what the customer paid for them is the order's
 * refund due, paid with the ordinary "Refund paid"; the order stays Delivered. The whole-order flows are
 * untouched — they only refuse an order that is already partly returned.
 */
before(connect);
after(disconnect);
afterEach(clear);

let seq = 0;

async function setup() {
  const biz = await makeBusiness();
  // Two articles: a suit at 3,000 (cost 1,000) and a dupatta at 500 (cost 200).
  const suit = await makeProduct(biz._id, [
    { label: 'M', costPrice: 1000, salePrice: 3000, stock: 10 }
  ]);
  const dupatta = await makeProduct(biz._id, [
    { label: 'One', costPrice: 200, salePrice: 500, stock: 10 }
  ]);
  // Two different names, so a line can be told apart by what it sells.
  await Product.updateOne({ _id: suit._id }, { name: 'Lawn Suit' });
  await Product.updateOne({ _id: dupatta._id }, { name: 'Dupatta' });
  suit.name = 'Lawn Suit';
  dupatta.name = 'Dupatta';
  const courier = await makeParty(biz._id, 'courier');
  const acc = async code => (await accountByCode(biz._id, code))._id;
  return { biz, suit, dupatta, courier, acc };
}

const net = async (ctx, code) => accountBalance(ctx.biz._id, await ctx.acc(code));
const stockOf = async product => (await Product.findById(product._id)).variants[0].stock;
const setStatus = (order, body) =>
  runHandler(updateOrderStatus, { resource: order, body: orderStatusSchema.parse(body) }).then(r =>
    Order.findById(r.body.data._id)
  );

/** A delivered order: 2 suits and 1 dupatta, as one customer bought them. */
async function delivered(ctx, { suits = 2, dupattas = 1 } = {}) {
  seq += 1;
  const out = await runHandler(createOrder, {
    body: orderCreateSchema.parse({
      business: String(ctx.biz._id),
      customerName: 'Sana',
      contactNumber: '03004445555',
      items: [
        {
          product: String(ctx.suit._id),
          variantId: String(ctx.suit.variants[0]._id),
          quantity: suits,
          unitPrice: 3000
        },
        {
          product: String(ctx.dupatta._id),
          variantId: String(ctx.dupatta.variants[0]._id),
          quantity: dupattas,
          unitPrice: 500
        }
      ]
    })
  });
  let order = await Order.findById(out.body.data._id);
  order = await setStatus(order, {
    status: 'dispatched',
    courier: String(ctx.courier._id),
    trackingId: `TRK${seq}`
  });
  return setStatus(order, { status: 'delivered', deliveryCharge: 200 });
}

const send = async (order, body) =>
  Order.findById(
    (
      await runHandler(partialReturnOrder, {
        resource: await Order.findById(order._id),
        user: { id: String(order.createdBy) },
        body: orderPartialReturnSchema.parse(body)
      })
    ).body.data._id
  );

const lineOf = (order, name) => String(order.items.find(i => i.productName === name)._id);

test('one suit of two comes back: only it returns to stock, its cost and sale are reversed, the order stays delivered', async () => {
  const ctx = await setup();
  const order = await delivered(ctx); // 2 suits + 1 dupatta = 6,500
  const salesBefore = await net(ctx, CODES.SALES);
  const cogsBefore = await net(ctx, CODES.COGS);
  const invBefore = await net(ctx, CODES.INVENTORY);
  const stockBefore = await stockOf(ctx.suit);

  const done = await send(order, { lines: [{ line: lineOf(order, ctx.suit.name), quantity: 1 }] });

  assert.equal(done.status, 'delivered', 'it was delivered; part came back');
  assert.equal(await stockOf(ctx.suit), stockBefore + 1, 'exactly one suit is back on the shelf');
  assert.equal(await stockOf(ctx.dupatta), 10 - 1, 'the dupatta the customer kept is not touched');
  // Sales is a credit balance: reversing part of it moves the balance up towards zero.
  assert.equal(
    (await net(ctx, CODES.SALES)) - salesBefore,
    300000,
    'the sale comes down by one suit'
  );
  assert.equal(
    cogsBefore - (await net(ctx, CODES.COGS)),
    100000,
    'its cost comes off cost of goods'
  );
  assert.equal(
    (await net(ctx, CODES.INVENTORY)) - invBefore,
    100000,
    'and goes back into inventory'
  );
  assert.equal(done.returnedPieces, 1);
  assert.equal(done.returnedItems.length, 1);
  assert.equal(done.returnedItems[0].amountPaisa, 300000);
});

test('what the customer paid for it is the order’s refund due, paid with the ordinary Refund paid', async () => {
  const ctx = await setup();
  const order = await delivered(ctx);
  const done = await send(order, { lines: [{ line: lineOf(order, ctx.suit.name), quantity: 1 }] });
  assert.equal(done.refundDuePaisa, 300000);

  const cash = String(await ctx.acc(CODES.CASH));
  const paid = await runHandler(addOrderRefund, {
    resource: done,
    user: { id: String(done.createdBy), role: { fullAccess: true } },
    body: orderMoneySchema.parse({ amount: 3000, account: cash })
  });
  assert.equal(paid.status, 201);
  assert.equal((await Order.findById(done._id)).refundDuePaisa, 0);
  assert.equal(await net(ctx, CODES.CUSTOMER_ADVANCES), 0, 'nothing is left owed to the customer');
});

test('"kept back" comes off the refund; it can not be more than the returned items cost', async () => {
  const ctx = await setup();
  const order = await delivered(ctx);
  const done = await send(order, {
    lines: [{ line: lineOf(order, ctx.suit.name), quantity: 1 }],
    keep: 200
  });
  assert.equal(done.refundDuePaisa, 280000);

  await assert.rejects(
    send(await Order.findById(order._id), {
      lines: [{ line: lineOf(order, ctx.dupatta.name), quantity: 1 }],
      keep: 600
    }),
    /keep back more than/
  );
});

test('the same line can come back in two goes, never more than was delivered', async () => {
  const ctx = await setup();
  const order = await delivered(ctx, { suits: 3 });
  const line = lineOf(order, ctx.suit.name);

  await send(order, { lines: [{ line, quantity: 1 }] });
  const second = await send(order, { lines: [{ line, quantity: 1 }] });
  assert.equal(second.returnedPieces, 2);
  assert.equal(returnableLines(second).find(l => l.line === line).left, 1);

  await assert.rejects(
    send(order, { lines: [{ line, quantity: 2 }] }),
    /Only 1 of .* can still go back/
  );
  assert.equal(await stockOf(ctx.suit), 10 - 3 + 2, 'nothing more came back');
});

test('a mixed return in one go: some of one article, all of another, the rest kept', async () => {
  const ctx = await setup();
  const order = await delivered(ctx, { suits: 2, dupattas: 2 });
  const done = await send(order, {
    lines: [
      { line: lineOf(order, ctx.suit.name), quantity: 1 },
      { line: lineOf(order, ctx.dupatta.name), quantity: 2 }
    ]
  });
  assert.equal(done.returnedPieces, 3);
  assert.equal(done.refundDuePaisa, 300000 + 100000);
  assert.equal(await stockOf(ctx.suit), 10 - 2 + 1);
  assert.equal(await stockOf(ctx.dupatta), 10 - 2 + 2);
});

test('every piece is not "some": the whole-order flows handle that', async () => {
  const ctx = await setup();
  const order = await delivered(ctx, { suits: 1, dupattas: 1 });
  await assert.rejects(
    send(order, {
      lines: [
        { line: lineOf(order, ctx.suit.name), quantity: 1 },
        { line: lineOf(order, ctx.dupatta.name), quantity: 1 }
      ]
    }),
    /every piece/
  );
  assert.equal((await Order.findById(order._id)).returnedItems.length, 0, 'nothing was posted');
});

test('a bad line leaves nothing half done', async () => {
  const ctx = await setup();
  const order = await delivered(ctx);
  const stockBefore = await stockOf(ctx.suit);
  const entriesBefore = await JournalEntry.countDocuments({ business: ctx.biz._id });

  await assert.rejects(
    send(order, {
      lines: [
        { line: lineOf(order, ctx.suit.name), quantity: 1 },
        { line: '64b000000000000000000000', quantity: 1 }
      ]
    }),
    /not on this order/
  );
  assert.equal(await stockOf(ctx.suit), stockBefore);
  assert.equal(await JournalEntry.countDocuments({ business: ctx.biz._id }), entriesBefore);
});

test('only a delivered order, and not one already exchanged', async () => {
  const ctx = await setup();
  seq += 1;
  const out = await runHandler(createOrder, {
    body: orderCreateSchema.parse({
      business: String(ctx.biz._id),
      customerName: 'Sana',
      contactNumber: '03004445555',
      items: [
        {
          product: String(ctx.suit._id),
          variantId: String(ctx.suit.variants[0]._id),
          quantity: 2,
          unitPrice: 3000
        }
      ]
    })
  });
  const pending = await Order.findById(out.body.data._id);
  await assert.rejects(
    send(pending, { lines: [{ line: String(pending.items[0]._id), quantity: 1 }] }),
    /Only a delivered order/
  );
});

test('the courier’s COD and delivery charge are left alone', async () => {
  const ctx = await setup();
  const order = await delivered(ctx);
  const codReceivable = await net(ctx, CODES.COD_RECEIVABLE);
  const deliveryCharges = await net(ctx, CODES.DELIVERY_CHARGES);
  await send(order, { lines: [{ line: lineOf(order, ctx.suit.name), quantity: 1 }] });
  assert.equal(await net(ctx, CODES.COD_RECEIVABLE), codReceivable);
  assert.equal(await net(ctx, CODES.DELIVERY_CHARGES), deliveryCharges);
});

test('the books stay balanced and the timeline says what came back', async () => {
  const ctx = await setup();
  const order = await delivered(ctx);
  const done = await send(order, {
    lines: [{ line: lineOf(order, ctx.suit.name), quantity: 1 }],
    keep: 100
  });

  const entries = await JournalEntry.find({ business: ctx.biz._id });
  for (const e of entries) {
    const debit = e.lines.reduce((s, l) => s + l.debitPaisa, 0);
    const credit = e.lines.reduce((s, l) => s + l.creditPaisa, 0);
    assert.equal(debit, credit, `entry "${e.memo}" balances`);
  }
  assert.match(done.activity.at(-1).text, /Sent back: 1 × .* — Rs 3,000 back to the customer/);
});

test('after a partial return the rest can only go back piece by piece, not as a whole order', async () => {
  const ctx = await setup();
  const order = await delivered(ctx);
  const done = await send(order, { lines: [{ line: lineOf(order, ctx.suit.name), quantity: 1 }] });

  await assert.rejects(
    runHandler(refundReturnOrder, {
      resource: await Order.findById(done._id),
      body: orderRefundReturnSchema.parse({ returnBy: 'customer' })
    }),
    /piece by piece/
  );
  await assert.rejects(
    runHandler(exchangeReturn, {
      resource: await Order.findById(done._id),
      body: { returnCourierName: 'TCS' }
    }),
    /piece by piece/
  );
});

test('the schema wants at least one line of whole pieces', () => {
  assert.equal(orderPartialReturnSchema.safeParse({ lines: [] }).success, false);
  assert.equal(
    orderPartialReturnSchema.safeParse({ lines: [{ line: 'a', quantity: 0 }] }).success,
    false
  );
  assert.equal(
    orderPartialReturnSchema.safeParse({ lines: [{ line: 'a', quantity: 1.5 }] }).success,
    false
  );
  assert.equal(
    orderPartialReturnSchema.safeParse({ lines: [{ line: 'a', quantity: 2 }], keep: 0 }).success,
    true
  );
});
