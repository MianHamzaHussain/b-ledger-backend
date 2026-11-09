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
import Order from '../models/Order.js';
import Product from '../models/Product.js';
import Party from '../models/Party.js';
import CourierReceipt from '../models/CourierReceipt.js';
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { accountBalance } from '../utils/ledger.js';
import {
  createOrder,
  updateOrderStatus,
  addCustomCost,
  addOrderAdvance,
  addOrderRefund,
  getRefundQuote,
  refundReturnOrder
} from '../controllers/orderController.js';
import { createCourierInvoice } from '../controllers/courierInvoiceController.js';
import {
  orderCreateSchema,
  orderStatusSchema,
  orderRefundReturnSchema,
  orderMoneySchema,
  customCostSchema
} from '../schemas/orders.js';
import { courierInvoiceSchema } from '../schemas/parties.js';
import { settleCourierCosts } from '../utils/courierCosts.js';

/**
 * Delivered, then sent back for a refund: the goods come back into stock and the
 * sale becomes money owed back — less the courier's costs (delivery charge and COD tax), taken off only once
 * PostEx has billed them (or by an admin paying early). The customer usually ships it back on their own courier, which
 * never reaches our invoice. Suits sell for 3,000 and cost 1,000; COD tax is
 * 2% + 2%.
 *
 * A made-from-scratch piece whose order falls through goes into stock as a
 * product of its own, never into a loss.
 */

before(connect);
after(disconnect);
afterEach(clear);

let seq = 0;

async function setup() {
  const biz = await makeBusiness();
  const product = await makeProduct(biz._id, [
    { label: 'M', costPrice: 1000, salePrice: 3000, stock: 10 }
  ]);
  const courier = await makeParty(biz._id, 'courier');
  const supplier = await makeParty(biz._id, 'supplier');
  const acc = async code => (await accountByCode(biz._id, code))._id;
  return {
    biz,
    product,
    courier,
    supplier: String(supplier._id),
    cash: String(await acc(CODES.CASH)),
    acc
  };
}

const net = async (ctx, code) => accountBalance(ctx.biz._id, await ctx.acc(code));
const setStatus = (order, body) =>
  runHandler(updateOrderStatus, { resource: order, body: orderStatusSchema.parse(body) }).then(r =>
    Order.findById(r.body.data._id)
  );

async function newOrder(ctx, extra = {}) {
  seq += 1;
  const out = await runHandler(createOrder, {
    body: orderCreateSchema.parse({
      business: String(ctx.biz._id),
      customerName: 'Sana',
      contactNumber: '03004445555',
      items: [
        {
          product: String(ctx.product._id),
          variantId: String(ctx.product.variants[0]._id),
          quantity: 1,
          unitPrice: 3000
        }
      ],
      ...extra
    })
  });
  return Order.findById(out.body.data._id);
}

async function deliver(ctx, order, charge) {
  order = await setStatus(order, {
    status: 'dispatched',
    courier: String(ctx.courier._id),
    trackingId: `TRK${seq}`
  });
  return setStatus(order, {
    status: 'delivered',
    ...(charge != null ? { deliveryCharge: charge } : {})
  });
}

const refund = async (order, body) =>
  Order.findById(
    (
      await runHandler(refundReturnOrder, {
        resource: order,
        body: orderRefundReturnSchema.parse(body)
      })
    ).body.data._id
  );

const stock = async ctx => (await Product.findById(ctx.product._id)).variants[0].stock;

const ADMIN = { id: userId, role: { fullAccess: true } };
const STAFF = { id: userId, role: { fullAccess: false, permissions: [] } };

/** PostEx's receipt for this order: delivery 200.00 (shipping 170.00 + GST 30.00) and 4 % of the 3,000 COD = 120.00. */
const billed = (ctx, order) =>
  CourierReceipt.create({
    business: ctx.biz._id,
    courier: ctx.courier._id,
    cprNumber: `CPR-${order.orderNumber}`,
    cprDate: new Date(),
    rows: [
      {
        tracking: order.trackingId,
        status: 'delivered',
        codPaisa: 300000,
        shippingPaisa: 17000,
        gstPaisa: 3000,
        deductionPaisa: 12000,
        netPaisa: 268000,
        order: order._id,
        outcome: 'applied'
      }
    ]
  });

const pay = (order, amount, ctx, extra = {}, user) =>
  runHandler(addOrderRefund, {
    resource: order,
    ...(user ? { user } : {}),
    body: orderMoneySchema.parse({ amount, account: ctx.cash, ...extra })
  });

test('the quote lists the courier costs: delivery charge and the 4 % tax on the COD only', async () => {
  const ctx = await setup();
  const unbilled = await deliver(ctx, await newOrder(ctx));
  let q = (await runHandler(getRefundQuote, { resource: unbilled, query: {} })).body.data;
  assert.equal(q.paid, 3000);
  assert.equal(q.totalCost, 120, 'no delivery charge yet, tax is 4 % of 3,000');
  assert.equal(q.isFinal, false);

  const tracked = await deliver(ctx, await newOrder(ctx), 200);
  q = (await runHandler(getRefundQuote, { resource: tracked, query: {} })).body.data;
  assert.equal(q.totalCost, 320);
  assert.equal(q.netRefund, 2680);
  assert.equal(q.isFinal, false, 'the status check is not PostEx’s receipt');

  await billed(ctx, tracked);
  q = (await runHandler(getRefundQuote, { resource: tracked, query: {} })).body.data;
  assert.equal(q.isFinal, true);
  assert.deepEqual(
    q.lines.map(l => l.amount),
    [200, 120]
  );
});

test('sent back on their own courier: nothing is paid until PostEx has billed; then the costs come off', async () => {
  const ctx = await setup();
  let order = await deliver(ctx, await newOrder(ctx), 200);
  const stockBefore = await stock(ctx);

  order = await refund(order, {
    returnBy: 'customer',
    returnCourierName: 'Leopards',
    reversalTrackingId: 'LP123'
  });
  assert.equal(order.status, 'refunded');
  assert.equal(await stock(ctx), stockBefore + 1);
  assert.equal(order.refundDuePaisa, 300000, 'the whole payment is held until the costs are known');
  assert.equal(order.returnChargePaisa, 0); // closed: never billed to us
  assert.equal(order.returnShipping.courierName, 'Leopards');
  assert.equal(await net(ctx, CODES.CHARGES_KEPT), 0, 'nothing is kept back at the return');

  await assert.rejects(pay(order, 2680, ctx), /has not billed/);

  await billed(ctx, order);
  order = Order.hydrate((await pay(order, 2680, ctx)).body.data);
  assert.equal(order.refundDuePaisa, 0);
  assert.equal(
    await net(ctx, CODES.CHARGES_KEPT),
    -32000,
    'delivery 200.00 + tax 120.00 kept back'
  );
  assert.equal(await net(ctx, CODES.SALES), 0);
  assert.equal(await net(ctx, CODES.CUSTOMER_ADVANCES), 0);
  const fresh = await Order.findById(order._id);
  assert.equal(fresh.courierCosts.lines.length, 2);
  assert.equal(fresh.customerMoney.filter(m => m.kind === 'kept').length, 2);
});

test('paying twice settles the costs once', async () => {
  const ctx = await setup();
  let order = await deliver(ctx, await newOrder(ctx), 200);
  order = await refund(order, { returnBy: 'customer' });
  await billed(ctx, order);
  order = Order.hydrate((await pay(order, 1000, ctx)).body.data);
  order = Order.hydrate((await pay(order, 1680, ctx)).body.data);
  assert.equal(await net(ctx, CODES.CHARGES_KEPT), -32000, 'kept back once, not twice');
  assert.equal(order.refundDuePaisa, 0);
});

test('we pay part of their shipping: it is added to the refund and is our return cost', async () => {
  const ctx = await setup();
  let order = await deliver(ctx, await newOrder(ctx), 200);
  order = await refund(order, { returnBy: 'customer', shippingShare: 150 });
  assert.equal(order.refundDuePaisa, 315000);
  assert.equal(await net(ctx, CODES.RETURN_CHARGES), 15000);
  await billed(ctx, order);
  order = Order.hydrate((await pay(order, 2830, ctx)).body.data);
  assert.equal(order.refundDuePaisa, 0);
});

test('our pickup: its charge is a courier cost too, and waits for PostEx', async () => {
  const ctx = await setup();
  let order = await deliver(ctx, await newOrder(ctx), 200);
  order = await refund(order, { returnBy: 'us', reversalTrackingId: 'REV9' });
  assert.equal(order.returnChargePaisa, undefined); // open on the invoice
  const q = (await runHandler(getRefundQuote, { resource: order, query: {} })).body.data;
  // delivery 200.00 + tax 120.00 + the pickup, estimated at the delivery charge 200.00
  assert.equal(q.totalCost, 520);
  assert.deepEqual(q.waitingFor.sort(), ['#' + order.orderNumber, 'return'].sort());
  await assert.rejects(pay(order, 100, ctx), /has not billed/);
});

test('only an admin can pay before PostEx has billed, and must say why', async () => {
  const ctx = await setup();
  let order = await deliver(ctx, await newOrder(ctx), 200);
  order = await refund(order, { returnBy: 'customer' });

  await assert.rejects(
    pay(order, 2680, ctx, { early: true, reason: 'customer waiting' }, STAFF),
    /Only an admin/
  );
  await assert.rejects(pay(order, 2680, ctx, { early: true }, ADMIN), /Say why/);

  order = Order.hydrate(
    (await pay(order, 2680, ctx, { early: true, reason: 'customer waiting' }, ADMIN)).body.data
  );
  assert.equal(order.refundDuePaisa, 0);
  assert.equal(await net(ctx, CODES.CHARGES_KEPT), -32000, 'the estimate is what was kept');
  const fresh = await Order.findById(order._id);
  assert.equal(fresh.courierCosts.early, true);
  assert.equal(fresh.courierCosts.reason, 'customer waiting');
});

test('a refund can be waived by an admin: nothing is kept back', async () => {
  const ctx = await setup();
  let order = await deliver(ctx, await newOrder(ctx), 200);
  order = await refund(order, { returnBy: 'customer' });
  await assert.rejects(
    settleCourierCosts(order, { userId, user: STAFF, waive: true, reason: 'faulty item' }),
    /Only an admin/
  );
  await settleCourierCosts(order, { userId, user: ADMIN, waive: true, reason: 'faulty item' });
  order = await Order.findById(order._id);
  assert.equal(order.refundDuePaisa, 300000);
  assert.equal(order.courierCosts.waived, true);
  order = Order.hydrate((await pay(order, 3000, ctx)).body.data);
  assert.equal(order.refundDuePaisa, 0);
  assert.equal(await net(ctx, CODES.CHARGES_KEPT), 0);
});

test('a real case: Rs 1,000 advance + Rs 14,000 COD, PostEx billed 268.25 and 560.00 tax → Rs 14,171.75 back', async () => {
  const ctx = await setup();
  const big = await newOrder(ctx, {
    items: [
      {
        product: String(ctx.product._id),
        variantId: String(ctx.product.variants[0]._id),
        quantity: 1,
        unitPrice: 15000
      }
    ]
  });
  await runHandler(addOrderAdvance, {
    resource: big,
    body: orderMoneySchema.parse({ amount: 1000, account: ctx.cash })
  });
  let order = await deliver(ctx, await Order.findById(big._id), 268.25);
  assert.equal(order.codAmount, 14000);
  order = await refund(order, { returnBy: 'customer' });
  assert.equal(order.refundDuePaisa, 1500000);

  await CourierReceipt.create({
    business: ctx.biz._id,
    courier: ctx.courier._id,
    cprNumber: 'CPR-REAL',
    cprDate: new Date(),
    rows: [
      {
        tracking: order.trackingId,
        status: 'delivered',
        codPaisa: 1400000,
        shippingPaisa: 23300,
        gstPaisa: 3525,
        deductionPaisa: 56000,
        netPaisa: 1317175,
        order: order._id,
        outcome: 'applied'
      }
    ]
  });
  const q = (await runHandler(getRefundQuote, { resource: order, query: {} })).body.data;
  assert.equal(q.netRefund, 14171.75, 'the tax is on the 14,000 COD, not the 1,000 advance');
  order = Order.hydrate((await pay(order, 14171.75, ctx)).body.data);
  assert.equal(order.refundDuePaisa, 0);
});

test('a refunded order whose COD the courier has not paid can still be settled on its invoice', async () => {
  const ctx = await setup();
  let order = await deliver(ctx, await newOrder(ctx), 200);
  order = await refund(order, { returnBy: 'customer' });
  await runHandler(createCourierInvoice, {
    resource: await Party.findById(ctx.courier._id),
    body: courierInvoiceSchema.parse({
      received: 2680,
      account: ctx.cash,
      cod: [String(order._id)]
    })
  });
  assert.equal((await Order.findById(order._id)).paymentStatus, 'paid');
});

// ── Made from scratch ──

async function scratchOrder(ctx) {
  const order = await newOrder(ctx, {
    items: [],
    customWork: [
      { description: 'Bridal lehenga, made to measure', price: 45000, fromScratch: true }
    ]
  });
  await runHandler(addCustomCost, {
    resource: order,
    body: customCostSchema.parse({
      description: 'Silk',
      amount: 9000,
      account: ctx.cash,
      party: ctx.supplier
    })
  });
  return Order.findById(order._id);
}

const customized = ctx => Product.find({ business: ctx.biz._id, customized: true });

test('a cancelled made-from-scratch order puts the piece into stock at its cost, not a loss', async () => {
  const ctx = await setup();
  let order = await scratchOrder(ctx);
  const work = order.customWork[0];
  order = await setStatus(order, {
    status: 'cancelled',
    scratchPieces: [{ workId: String(work._id), name: 'Red silk lehenga', salePrice: 42000 }]
  });

  const [piece] = await customized(ctx);
  assert.equal(piece.name, 'Red silk lehenga');
  assert.equal(piece.variants[0].stock, 1);
  assert.equal(piece.variants[0].costPrice, 9000);
  assert.equal(piece.variants[0].salePrice, 42000);
  assert.equal(await net(ctx, CODES.CUSTOM_WIP), 0);
  assert.equal(await net(ctx, CODES.CUSTOM_WRITE_OFF), 0);
  assert.equal(await net(ctx, CODES.INVENTORY), 900000);

  // Reopening takes it back out and puts the cost back on the order.
  order = await setStatus(order, { status: 'created' });
  assert.equal((await customized(ctx)).length, 0);
  assert.equal(await net(ctx, CODES.CUSTOM_WIP), 900000);
});

test('a piece sold since can not be taken back by reopening its order', async () => {
  const ctx = await setup();
  let order = await scratchOrder(ctx);
  order = await setStatus(order, { status: 'cancelled' });
  const [piece] = await customized(ctx);
  await Product.updateOne(
    { _id: piece._id, 'variants._id': piece.variants[0]._id },
    { $inc: { 'variants.$.stock': -1, totalStock: -1 } }
  );
  await assert.rejects(setStatus(order, { status: 'created' }), /sold since/);
});

test('a second piece with the same name joins the first as more stock', async () => {
  const ctx = await setup();
  await setStatus(await scratchOrder(ctx), { status: 'cancelled' });
  await setStatus(await scratchOrder(ctx), { status: 'cancelled' });
  const pieces = await customized(ctx);
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0].variants[0].stock, 2);
});

test('a made-from-scratch piece refunded after delivery goes back into stock out of COGS', async () => {
  const ctx = await setup();
  let order = await deliver(ctx, await scratchOrder(ctx), 200);
  assert.equal(await net(ctx, CODES.COGS), 900000);
  order = await refund(order, { returnBy: 'customer', keep: 0 });
  const [piece] = await customized(ctx);
  assert.equal(piece.variants[0].stock, 1);
  assert.equal(await net(ctx, CODES.COGS), 0);
  assert.equal(order.refundDuePaisa, 4500000);
});
