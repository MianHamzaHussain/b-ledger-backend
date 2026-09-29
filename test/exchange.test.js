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
import Party from '../models/Party.js';
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { accountBalance, partyBalance } from '../utils/ledger.js';
import {
  createOrder,
  updateOrderStatus,
  exchangeReturn,
  createReplacement,
  swapOrder,
  receiveReturn
} from '../controllers/orderController.js';
import { createCourierInvoice } from '../controllers/courierInvoiceController.js';
import {
  orderCreateSchema,
  orderStatusSchema,
  orderExchangeReturnSchema,
  orderSwapSchema,
  orderReplacementSchema
} from '../schemas/orders.js';
import { courierInvoiceSchema } from '../schemas/parties.js';
import { toPaisa } from '../utils/money.js';

/**
 * An exchange doesn't refund the customer — what they paid for the original
 * becomes credit on the replacement, so its COD is only the price difference.
 * What the courier did (collected the COD, charged its fee) stays booked.
 * Suits here sell for 3,000 and cost 1,000.
 */

before(connect);
after(disconnect);
afterEach(clear);

let seq = 0;

async function setup() {
  const biz = await makeBusiness();
  const product = await makeProduct(biz._id, [
    { label: 'M', costPrice: 1000, salePrice: 3000, stock: 10 },
    { label: 'L', costPrice: 1000, salePrice: 3000, stock: 10 }
  ]);
  const courier = await makeParty(biz._id, 'courier');
  const acc = async code => (await accountByCode(biz._id, code))._id;
  return {
    biz,
    product,
    courier,
    cash: String(await acc(CODES.CASH)),
    liability: await acc(CODES.CUSTOMER_ADVANCES),
    sales: await acc(CODES.SALES),
    inventory: await acc(CODES.INVENTORY)
  };
}

const line = (ctx, variant = 0, unitPrice = 3000) => ({
  product: String(ctx.product._id),
  variantId: String(ctx.product.variants[variant]._id),
  quantity: 1,
  unitPrice
});

const setStatus = (order, body) =>
  runHandler(updateOrderStatus, { resource: order, body: orderStatusSchema.parse(body) }).then(r =>
    Order.findById(r.body.data._id)
  );

/** A courier order for one M suit, delivered (charge left for the invoice). */
async function delivered(ctx, extra = {}) {
  seq += 1;
  const out = await runHandler(createOrder, {
    body: orderCreateSchema.parse({
      business: String(ctx.biz._id),
      customerName: 'Sana',
      contactNumber: '03004445555',
      items: [line(ctx)],
      ...extra
    })
  });
  let order = await Order.findById(out.body.data._id);
  order = await setStatus(order, {
    status: 'dispatched',
    courier: String(ctx.courier._id),
    trackingId: `TRK${seq}`
  });
  return setStatus(order, { status: 'delivered' });
}

const stockOf = async (ctx, variant) =>
  (await Product.findById(ctx.product._id)).variants[variant].stock;
const balance = (ctx, account) => accountBalance(ctx.biz._id, account);

test('return first, after the courier paid: its khata stays right and the like-for-like replacement is COD 0', async () => {
  const ctx = await setup();
  let original = await delivered(ctx);

  // The courier's invoice pays this COD (2,880 net of 2% + 2%).
  await runHandler(createCourierInvoice, {
    resource: await Party.findById(ctx.courier._id),
    body: courierInvoiceSchema.parse({
      received: 2880,
      account: ctx.cash,
      cod: [String(original._id)]
    })
  });
  const courierBefore = await partyBalance(ctx.biz._id, ctx.courier._id);
  original = await Order.findById(original._id);

  const stockBefore = await stockOf(ctx, 0);
  const back = await runHandler(exchangeReturn, {
    resource: original,
    body: orderExchangeReturnSchema.parse({ reversalTrackingId: 'REV1' })
  });
  original = await Order.findById(back.body.data._id);

  assert.equal(
    await partyBalance(ctx.biz._id, ctx.courier._id),
    courierBefore,
    'courier untouched'
  );
  assert.equal(await balance(ctx, ctx.sales), 0, 'sale undone');
  assert.equal(await balance(ctx, ctx.liability), -toPaisa(3000), 'held for the customer');
  assert.equal(await stockOf(ctx, 0), stockBefore + 1, 'the suit is back in stock');
  assert.equal(original.reversalTrackingId, 'REV1');
  assert.equal(original.status, 'exchanged');

  // Same price, other size: nothing more to collect.
  const out = await runHandler(createReplacement, {
    resource: original,
    body: orderReplacementSchema.parse({ items: [line(ctx, 1)] })
  });
  const replacement = await Order.findById(out.body.data._id);
  assert.equal(replacement.codAmount, 0);
  assert.equal(replacement.refundDuePaisa, 0);
  original = await Order.findById(original._id);
  assert.equal(original.refundDuePaisa, 0, 'the credit moved to the replacement');

  // Delivering the replacement uses the credit — nothing left owed either way.
  let r = await setStatus(replacement, {
    status: 'dispatched',
    courier: String(ctx.courier._id),
    trackingId: 'TRK-R1'
  });
  r = await setStatus(r, { status: 'delivered' });
  assert.equal(await balance(ctx, ctx.liability), 0);
  assert.equal(await balance(ctx, ctx.sales), -toPaisa(3000), 'one sale, not two');
});

test('a dearer replacement collects the difference; a cheaper one owes a refund', async () => {
  const ctx = await setup();
  const first = await delivered(ctx);
  await runHandler(exchangeReturn, { resource: first, body: {} });
  const dearer = await runHandler(createReplacement, {
    resource: await Order.findById(first._id),
    body: orderReplacementSchema.parse({ items: [line(ctx, 1, 3500)] })
  });
  assert.equal(dearer.body.data.codAmount, 500);

  const second = await delivered(ctx);
  await runHandler(exchangeReturn, { resource: second, body: {} });
  const cheaper = await runHandler(createReplacement, {
    resource: await Order.findById(second._id),
    body: orderReplacementSchema.parse({ items: [line(ctx, 1, 2600)] })
  });
  assert.equal(cheaper.body.data.codAmount, 0);
  assert.equal(cheaper.body.data.refundDuePaisa, toPaisa(400));
});

test("an advance is part of the customer's credit", async () => {
  const ctx = await setup();
  let original = await delivered(ctx, { advanceAmount: 500, advanceAccount: ctx.cash });
  assert.equal(original.codAmount, 2500);
  await runHandler(exchangeReturn, { resource: original, body: {} });
  original = await Order.findById(original._id);
  assert.equal(original.refundDuePaisa, toPaisa(3000), 'the advance + the COD, all of it');
});

test('swap at the door: the replacement goes now, the stock only when the old item arrives', async () => {
  const ctx = await setup();
  let original = await delivered(ctx);
  const stockM = await stockOf(ctx, 0);
  const stockL = await stockOf(ctx, 1);

  const out = await runHandler(swapOrder, {
    resource: original,
    body: orderSwapSchema.parse({ items: [line(ctx, 1)], reversalTrackingId: 'REV-SWAP' })
  });
  const replacement = await Order.findById(out.body.data._id);
  original = await Order.findById(original._id);

  assert.equal(replacement.codAmount, 0);
  assert.equal(await stockOf(ctx, 1), stockL - 1, 'the replacement is held from stock');
  assert.equal(await stockOf(ctx, 0), stockM, 'the old item is not back yet');
  assert.equal(original.awaitingReturn, true);
  assert.equal(original.reversalTrackingId, 'REV-SWAP');
  assert.equal(String(original.exchangedFor), String(replacement._id));

  await runHandler(receiveReturn, { resource: original, body: { returnCharge: 230 } });
  original = await Order.findById(original._id);
  assert.equal(original.awaitingReturn, false);
  assert.equal(await stockOf(ctx, 0), stockM + 1, 'back on the shelf');
  assert.equal(original.returnChargePaisa, toPaisa(230), 'the reversal parcel is charged too');
});

test('a swap that runs out of stock leaves the original untouched', async () => {
  const ctx = await setup();
  const original = await delivered(ctx);
  const entriesBefore = await JournalEntry.countDocuments();
  await assert.rejects(
    runHandler(swapOrder, {
      resource: original,
      body: orderSwapSchema.parse({ items: [{ ...line(ctx, 1), quantity: 99 }] })
    })
  );
  const fresh = await Order.findById(original._id);
  assert.equal(fresh.status, 'delivered');
  assert.equal(await JournalEntry.countDocuments(), entriesBefore, 'nothing posted');
});

test('a counter sale is not exchanged through the courier flow', async () => {
  const ctx = await setup();
  const out = await runHandler(createOrder, {
    body: orderCreateSchema.parse({
      business: String(ctx.biz._id),
      customerName: 'Walk-in',
      contactNumber: '03009990000',
      source: 'walk-in',
      advanceAmount: 3000,
      advanceAccount: ctx.cash,
      items: [line(ctx)]
    })
  });
  const sale = await Order.findById(out.body.data._id);
  await assert.rejects(runHandler(exchangeReturn, { resource: sale, body: {} }), /counter/);
});

test('a replacement is a new order: custom work, another courier, a new address', async () => {
  const ctx = await setup();
  const leopards = await makeParty(ctx.biz._id, 'courier', { name: 'Leopards' });
  let original = await delivered(ctx);
  await runHandler(exchangeReturn, {
    resource: original,
    body: orderExchangeReturnSchema.parse({
      returnCourierName: 'TCS',
      reversalTrackingId: 'CUST-1'
    })
  });
  original = await Order.findById(original._id);
  assert.equal(original.returnChargePaisa, 0, 'their courier — never on our invoice');

  const out = await runHandler(createReplacement, {
    resource: original,
    body: orderReplacementSchema.parse({
      customWork: [{ description: 'Kurta, made to measure', price: 2000, fromScratch: true }],
      courier: String(leopards._id),
      deliveryAddress: 'House 5, New Town'
    })
  });
  const replacement = await Order.findById(out.body.data._id);
  assert.equal(replacement.customWork.length, 1);
  assert.equal(String(replacement.courier), String(leopards._id));
  assert.equal(replacement.deliveryAddress, 'House 5, New Town');
  // 3,000 credit against a 2,000 piece: nothing to collect, 1,000 owed back.
  assert.equal(replacement.codAmount, 0);
  assert.equal(replacement.refundDuePaisa, toPaisa(1000));
});

test('a dearer swap: no COD — the difference is paid to us directly, as an advance', async () => {
  const ctx = await setup();
  const original = await delivered(ctx);
  const body = {
    items: [line(ctx, 1)],
    customWork: [{ description: 'Extra embroidery', price: 1500 }]
  };
  await assert.rejects(
    runHandler(swapOrder, { resource: original, body: orderSwapSchema.parse(body) }),
    /pays the difference to you directly/
  );

  const out = await runHandler(swapOrder, {
    resource: await Order.findById(original._id),
    body: orderSwapSchema.parse({ ...body, differenceAccount: ctx.cash })
  });
  const replacement = await Order.findById(out.body.data._id);
  assert.equal(replacement.codAmount, 0, 'the rider collects nothing');
  assert.equal(replacement.isSwap, true);
  assert.ok(replacement.customerMoney.some(m => m.kind === 'advance' && m.amountPaisa === 150000));
  assert.equal(
    await balance(ctx, await (async () => (await accountByCode(ctx.biz._id, CODES.CASH))._id)()),
    150000
  );
});

test('a swap keeps the original courier — at creation and at dispatch', async () => {
  const ctx = await setup();
  const other = await makeParty(ctx.biz._id, 'courier', { name: 'Leopards' });
  const original = await delivered(ctx);
  const out = await runHandler(swapOrder, {
    resource: original,
    // A courier sent anyway is dropped: the schema has no courier for a swap.
    body: orderSwapSchema.parse({ items: [line(ctx, 1)], courier: String(other._id) })
  });
  let replacement = await Order.findById(out.body.data._id);
  assert.equal(String(replacement.courier), String(ctx.courier._id));

  await assert.rejects(
    runHandler(updateOrderStatus, {
      resource: replacement,
      body: orderStatusSchema.parse({
        status: 'dispatched',
        courier: String(other._id),
        trackingId: 'LE-1'
      })
    }),
    /same courier as the original/
  );
  replacement = await setStatus(await Order.findById(replacement._id), {
    status: 'dispatched',
    courier: String(ctx.courier._id),
    trackingId: 'TCS-9'
  });
  assert.equal(replacement.status, 'dispatched');
});
