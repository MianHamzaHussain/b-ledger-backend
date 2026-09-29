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
import Party from '../models/Party.js';
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { accountBalance } from '../utils/ledger.js';
import {
  createOrder,
  updateOrderStatus,
  addCustomCost,
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

/**
 * Delivered, then sent back for a refund: the goods come back into stock and the
 * sale becomes money owed back — less what's kept (delivery charge and tax,
 * normally). The customer usually ships it back on their own courier, which
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
  const acc = async code => (await accountByCode(biz._id, code))._id;
  return { biz, product, courier, cash: String(await acc(CODES.CASH)), acc };
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

test('the quote keeps the delivery charge (once billed) and the FBR tax', async () => {
  const ctx = await setup();
  const unbilled = await deliver(ctx, await newOrder(ctx));
  let q = (await runHandler(getRefundQuote, { resource: unbilled })).body.data;
  assert.equal(q.deliveryChargePaisa, null);
  assert.equal(q.taxPaisa, 12000); // 4% of 3,000
  assert.equal(q.keepPaisa, 12000);

  const billed = await deliver(ctx, await newOrder(ctx), 200);
  q = (await runHandler(getRefundQuote, { resource: billed })).body.data;
  assert.equal(q.keepPaisa, 32000);
});

test('sent back on their own courier: stock back, refund due less what is kept, nothing on our invoice', async () => {
  const ctx = await setup();
  let order = await deliver(ctx, await newOrder(ctx), 200);
  const stockBefore = await stock(ctx);

  order = await refund(order, {
    returnBy: 'customer',
    returnCourierName: 'Leopards',
    reversalTrackingId: 'LP123',
    keep: 320
  });

  assert.equal(order.status, 'refunded');
  assert.equal(await stock(ctx), stockBefore + 1);
  assert.equal(order.refundDuePaisa, 268000);
  assert.equal(order.returnChargePaisa, 0); // closed: never billed to us
  assert.equal(order.returnShipping.courierName, 'Leopards');
  assert.equal(await net(ctx, CODES.CHARGES_KEPT), -32000);
  assert.equal(await net(ctx, CODES.SALES), 0);

  order = Order.hydrate(
    (
      await runHandler(addOrderRefund, {
        resource: order,
        body: orderMoneySchema.parse({ amount: 2680, account: ctx.cash })
      })
    ).body.data
  );
  assert.equal(order.refundDuePaisa, 0);
  assert.equal(await net(ctx, CODES.CUSTOMER_ADVANCES), 0);
});

test('we pay part of their shipping: it is added to the refund and is our return cost', async () => {
  const ctx = await setup();
  let order = await deliver(ctx, await newOrder(ctx), 200);
  order = await refund(order, { returnBy: 'customer', keep: 320, shippingShare: 150 });
  assert.equal(order.refundDuePaisa, 283000);
  assert.equal(await net(ctx, CODES.RETURN_CHARGES), 15000);
});

test('our pickup: its charge waits for the invoice, and their share is kept back', async () => {
  const ctx = await setup();
  let order = await deliver(ctx, await newOrder(ctx), 200);
  order = await refund(order, {
    returnBy: 'us',
    reversalTrackingId: 'REV9',
    keep: 320,
    shippingShare: 100
  });
  assert.equal(order.returnChargePaisa, undefined); // open on the invoice
  assert.equal(order.refundDuePaisa, 258000);
  assert.equal(await net(ctx, CODES.CHARGES_KEPT), -42000);
});

test('a refunded order whose COD the courier has not paid can still be settled on its invoice', async () => {
  const ctx = await setup();
  let order = await deliver(ctx, await newOrder(ctx), 200);
  order = await refund(order, { returnBy: 'customer', keep: 320 });
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

test('can not keep back more than the customer paid', async () => {
  const ctx = await setup();
  const order = await deliver(ctx, await newOrder(ctx));
  await assert.rejects(
    refund(order, { returnBy: 'customer', keep: 3500 }),
    /more than the customer paid/
  );
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
    body: customCostSchema.parse({ description: 'Silk', amount: 9000, account: ctx.cash })
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
  order = await setStatus(order, { status: 'pending' });
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
  await assert.rejects(setStatus(order, { status: 'pending' }), /sold since/);
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
