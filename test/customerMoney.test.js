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
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { accountBalance, partyBalance } from '../utils/ledger.js';
import {
  createOrder,
  updateOrder,
  updateOrderStatus,
  addOrderAdvance,
  addOrderRefund,
  deleteOrderMoney,
  keepOrderCredit
} from '../controllers/orderController.js';
import { reverseJournalEntry } from '../controllers/financeController.js';
import {
  orderCreateSchema,
  orderMoneySchema,
  orderStatusSchema,
  orderCreditSchema
} from '../schemas/orders.js';
import { toPaisa } from '../utils/money.js';

/**
 * The customer's own money on an order. An advance is booked the day it
 * arrives (Advances from customers). The COD takes it off until dispatch, then
 * freezes — the courier collects what it printed — so a later advance is owed
 * back. Every order here is one 3,000 suit.
 */

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

const money = (handler, order, body) =>
  runHandler(handler, { resource: order, body: orderMoneySchema.parse(body) }).then(r =>
    Order.findById(r.body.data._id)
  );
const setStatus = (order, body) =>
  runHandler(updateOrderStatus, { resource: order, body: orderStatusSchema.parse(body) }).then(r =>
    Order.findById(r.body.data._id)
  );
const balance = (ctx, account) => accountBalance(ctx.biz._id, account);

test('an advance at order time is booked that day, into the account chosen', async () => {
  const ctx = await setup();
  const order = await newOrder(ctx, { advanceAmount: 500, advanceAccount: ctx.bank });

  assert.equal(order.advanceAmount, 500);
  assert.equal(order.codAmount, 2500, 'the courier collects the rest');
  assert.equal(order.customerMoney.length, 1);
  assert.equal(await balance(ctx, ctx.bank), toPaisa(500), 'money is in the bank today');
  assert.equal(await balance(ctx, ctx.liability), -toPaisa(500), 'owed to the customer');
});

test('before dispatch an advance lowers the COD, but never past the total', async () => {
  const ctx = await setup();
  let order = await newOrder(ctx);
  assert.equal(order.codAmount, 3000);

  order = await money(addOrderAdvance, order, { amount: 1000, account: ctx.cash });
  assert.equal(order.codAmount, 2000);
  await assert.rejects(
    money(addOrderAdvance, order, { amount: 2500, account: ctx.cash }),
    /more than the order total/
  );
});

test('a late advance keeps the COD, becomes a refund due, and is paid back', async () => {
  const ctx = await setup();
  let order = await newOrder(ctx, { advanceAmount: 500, advanceAccount: ctx.cash });
  order = await setStatus(order, { status: 'confirmed' });
  order = await setStatus(order, {
    status: 'dispatched',
    courier: String(ctx.courier._id),
    trackingId: 'TRK1'
  });

  // The screenshot arrives after the airway bill was printed.
  order = await money(addOrderAdvance, order, { amount: 1000, account: ctx.bank });
  assert.equal(order.codAmount, 2500, 'COD frozen at dispatch');
  assert.equal(order.refundDuePaisa, toPaisa(1000));

  // Delivery uses only the advance the COD was printed without.
  order = await setStatus(order, { status: 'delivered' });
  const sale = await JournalEntry.findById(order.saleEntry);
  const used = sale.lines.find(l => String(l.account) === String(ctx.liability));
  assert.equal(used.debitPaisa, toPaisa(500));
  assert.equal(await balance(ctx, ctx.liability), -toPaisa(1000), 'the late 1,000 still owed');

  await assert.rejects(
    money(addOrderRefund, order, { amount: 1500, account: ctx.bank }),
    /Only Rs 1,000 is due back/
  );
  order = await money(addOrderRefund, order, { amount: 1000, account: ctx.bank });
  assert.equal(order.refundDuePaisa, 0);
  assert.equal(await balance(ctx, ctx.liability), 0);
  assert.equal(await balance(ctx, ctx.bank), 0, 'in and back out of the bank');
});

test('a cancelled order owes back everything it holds', async () => {
  const ctx = await setup();
  let order = await newOrder(ctx, { advanceAmount: 800, advanceAccount: ctx.cash });
  order = await setStatus(order, { status: 'cancelled' });
  assert.equal(order.refundDuePaisa, toPaisa(800));
});

test('removing an advance: fine before dispatch, refused once the COD was printed without it', async () => {
  const ctx = await setup();
  let order = await newOrder(ctx, { advanceAmount: 500, advanceAccount: ctx.cash });
  const first = order.customerMoney[0]._id;

  // Before dispatch: removed, entry reversed, COD back to full.
  let out = await runHandler(deleteOrderMoney, {
    resource: order,
    params: { rowId: String(first) }
  });
  order = await Order.findById(out.body.data._id);
  assert.equal(order.codAmount, 3000);
  assert.equal(await balance(ctx, ctx.cash), 0);

  order = await money(addOrderAdvance, order, { amount: 500, account: ctx.cash });
  order = await setStatus(order, {
    status: 'dispatched',
    courier: String(ctx.courier._id),
    trackingId: 'TRK2'
  });
  await assert.rejects(
    runHandler(deleteOrderMoney, {
      resource: order,
      params: { rowId: String(order.customerMoney[0]._id) }
    }),
    /COD was fixed/
  );

  // A late one is only a refund due — removing it is fine.
  order = await money(addOrderAdvance, order, { amount: 200, account: ctx.cash });
  out = await runHandler(deleteOrderMoney, {
    resource: order,
    params: { rowId: String(order.customerMoney[1]._id) }
  });
  order = await Order.findById(out.body.data._id);
  assert.equal(order.refundDuePaisa, 0);
});

test("an advance's entry can't be reversed from the journal", async () => {
  const ctx = await setup();
  const order = await newOrder(ctx, { advanceAmount: 500, advanceAccount: ctx.cash });
  const entry = await JournalEntry.findById(order.customerMoney[0].entry);
  await assert.rejects(
    runHandler(reverseJournalEntry, { resource: entry, body: {} }),
    /from its order/
  );
});

test('editing an order below its advance is refused', async () => {
  const ctx = await setup();
  const order = await newOrder(ctx, { advanceAmount: 2000, advanceAccount: ctx.cash });
  await assert.rejects(
    runHandler(updateOrder, {
      resource: order,
      body: {
        customerName: 'Hina',
        contactNumber: '03001112222',
        items: [
          {
            product: String(ctx.product._id),
            variantId: String(ctx.product.variants[0]._id),
            quantity: 1,
            unitPrice: 1500
          }
        ]
      }
    }),
    /more than the new total/
  );
});

test("a counter sale's payment goes into the account chosen, in the sale itself", async () => {
  const ctx = await setup();
  const order = await newOrder(ctx, {
    source: 'walk-in',
    advanceAmount: 3000,
    advanceAccount: ctx.bank
  });
  assert.equal(order.customerMoney.length, 0);
  assert.equal(await balance(ctx, ctx.bank), toPaisa(3000));
  assert.equal(await balance(ctx, ctx.liability), 0, 'no advance liability for a counter sale');
});

test('cancel with advance, then keep as credit', async () => {
  const ctx = await setup();
  let order = await newOrder(ctx, { advanceAmount: 800, advanceAccount: ctx.cash });
  order = await setStatus(order, { status: 'cancelled' });

  const out = await runHandler(keepOrderCredit, {
    resource: order,
    body: orderCreditSchema.parse({ amount: 800 })
  });
  order = await Order.findById(out.body.data._id);

  assert.equal(order.refundDuePaisa, 0);
  assert.equal(await balance(ctx, ctx.liability), 0);
  assert.equal(await partyBalance(ctx.biz._id, order.customerParty), -toPaisa(800));
});

test('credit on a pending order is refused', async () => {
  const ctx = await setup();
  const order = await newOrder(ctx, { advanceAmount: 800, advanceAccount: ctx.cash });

  await assert.rejects(
    runHandler(keepOrderCredit, {
      resource: order,
      body: orderCreditSchema.parse({ amount: 800 })
    }),
    /cancelled or returned/
  );
});

test('reopen a cancelled order holds its stock again', async () => {
  const ctx = await setup();
  let order = await newOrder(ctx, { advanceAmount: 500, advanceAccount: ctx.cash });
  order = await setStatus(order, { status: 'cancelled' });
  order = await setStatus(order, { status: 'pending' });

  assert.equal(order.status, 'pending');
  assert.equal(order.codAmount, 2500);
  assert.equal(order.refundDuePaisa, 0);

  // product starts with 50 items (from helper), 1 is reserved so it's 49
  const product = await ctx.product.constructor.findById(ctx.product._id);
  assert.equal(product.variants[0].stock, 49);
});
