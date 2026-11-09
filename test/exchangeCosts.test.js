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
import CourierReceipt from '../models/CourierReceipt.js';
import JournalEntry from '../models/JournalEntry.js';
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { accountBalance } from '../utils/ledger.js';
import {
  createOrder,
  updateOrderStatus,
  exchangeReturn,
  createReplacement,
  swapOrder,
  addOrderRefund,
  getExchangeQuote,
  waiveCourierCosts
} from '../controllers/orderController.js';
import {
  orderCreateSchema,
  orderStatusSchema,
  orderReplacementSchema,
  orderSwapSchema,
  orderMoneySchema
} from '../schemas/orders.js';

/**
 * An exchange recovers the courier's costs for BOTH parcels — the business absorbs none of it. Worked example (owner):
 * a 16,000 order exchanged for a 12,000 one, each parcel charged 268.25, 4 % tax on the COD.
 *   original  268.25 + 4 % × 16,000 (640.00) = 908.25      replacement  268.25 + 0 (no COD)
 *   payout    4,000 − 908.25 − 268.25 = Rs 2,823.50
 * A customer who owes (same price, dearer, or a small difference) pays it on the replacement's COD, in whole
 * rupees grossed up so the 4 % on that COD itself is covered.
 */
before(connect);
after(disconnect);
afterEach(clear);

let seq = 0;

async function setup() {
  const biz = await makeBusiness();
  const product = await makeProduct(biz._id, [
    { label: 'M', costPrice: 1000, salePrice: 3000, stock: 50 },
    { label: 'L', costPrice: 1000, salePrice: 3000, stock: 50 }
  ]);
  const courier = await makeParty(biz._id, 'courier');
  const acc = async code => (await accountByCode(biz._id, code))._id;
  return { biz, product, courier, cash: String(await acc(CODES.CASH)), acc };
}

const line = (ctx, price, variant = 0) => ({
  product: String(ctx.product._id),
  variantId: String(ctx.product.variants[variant]._id),
  quantity: 1,
  unitPrice: price
});

const setStatus = (order, body) =>
  runHandler(updateOrderStatus, { resource: order, body: orderStatusSchema.parse(body) }).then(r =>
    Order.findById(r.body.data._id)
  );

/** A delivered courier order of `price`, whose delivery charge the status check set to 268.25. */
async function delivered(ctx, price) {
  seq += 1;
  const out = await runHandler(createOrder, {
    body: orderCreateSchema.parse({
      business: String(ctx.biz._id),
      customerName: 'Sana',
      contactNumber: '03004445555',
      items: [line(ctx, price)]
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

/** PostEx's receipt for a parcel: shipping + GST 268.25 and the 4 % of its COD. */
const receiptFor = (ctx, order, codPaisa) =>
  CourierReceipt.create({
    business: ctx.biz._id,
    courier: ctx.courier._id,
    cprNumber: `CPR-${order.orderNumber}`,
    cprDate: new Date(),
    rows: [
      {
        tracking: order.trackingId,
        status: 'delivered',
        codPaisa,
        shippingPaisa: 23300,
        gstPaisa: 3525,
        deductionPaisa: Math.round(codPaisa * 0.04),
        netPaisa: codPaisa - 26825 - Math.round(codPaisa * 0.04),
        order: order._id,
        outcome: 'applied'
      }
    ]
  });

const exchange = async (ctx, original, price) => {
  await runHandler(exchangeReturn, { resource: original, body: {} });
  const out = await runHandler(createReplacement, {
    resource: await Order.findById(original._id),
    body: orderReplacementSchema.parse({ items: [line(ctx, price, 1)] })
  });
  return Order.findById(out.body.data._id);
};

const keptNet = async ctx => accountBalance(ctx.biz._id, await ctx.acc(CODES.CHARGES_KEPT));

test('16,000 → 12,000: the customer is owed 4,000 less both parcels’ costs = 2,823.50', async () => {
  const ctx = await setup();
  const original = await delivered(ctx, 16000);
  let replacement = await exchange(ctx, original, 12000);
  assert.equal(replacement.codAmount, 0, 'nothing for the customer to pay');
  assert.equal(
    replacement.refundDuePaisa,
    400000,
    'held gross until PostEx has billed both parcels'
  );

  replacement = await setStatus(replacement, {
    status: 'dispatched',
    courier: String(ctx.courier._id),
    trackingId: 'TRK-REPL'
  });
  replacement = await setStatus(replacement, { status: 'delivered', deliveryCharge: 268.25 });

  const pay = () =>
    runHandler(addOrderRefund, {
      resource: replacement,
      body: orderMoneySchema.parse({ amount: 2823.5, account: ctx.cash })
    });
  await assert.rejects(pay(), /has not billed/);

  await receiptFor(ctx, await Order.findById(original._id), 1600000);
  await receiptFor(ctx, replacement, 0);
  const out = await pay();
  assert.equal(out.body.data.refundDuePaisa, 0);
  // 908.25 for the original + 268.25 for the replacement were kept back.
  assert.equal(await keptNet(ctx), -117650);
});

test('12,000 → 16,000: the customer pays 4,000 + both costs on the COD (5,226)', async () => {
  const ctx = await setup();
  const original = await delivered(ctx, 12000);
  const replacement = await exchange(ctx, original, 16000);
  // original: 268.25 + 480.00 tax; replacement estimate 268.25 → 4,000 + 1,016.50 = 5,016.50, grossed up for 4 %.
  assert.equal(replacement.codAmount, 5226);
  assert.equal(replacement.refundDuePaisa, 0);
  assert.equal(replacement.courierCosts.exchange, true);
  assert.equal(replacement.courierCosts.settledAt instanceof Date, true);

  // It delivers with a balanced entry, using the credit that is left after the costs.
  let r = await setStatus(replacement, {
    status: 'dispatched',
    courier: String(ctx.courier._id),
    trackingId: 'TRK-R2'
  });
  r = await setStatus(r, { status: 'delivered', deliveryCharge: 268.25 });
  for (const e of await JournalEntry.find({ business: ctx.biz._id })) {
    const debit = e.lines.reduce((s, l) => s + l.debitPaisa, 0);
    const credit = e.lines.reduce((s, l) => s + l.creditPaisa, 0);
    assert.equal(debit, credit, `"${e.memo}" balances`);
  }
  assert.equal(await accountBalance(ctx.biz._id, await ctx.acc(CODES.CUSTOMER_ADVANCES)), 0);
});

test('16,000 → 16,000: the customer pays both costs, COD 1,226', async () => {
  const ctx = await setup();
  const original = await delivered(ctx, 16000);
  const replacement = await exchange(ctx, original, 16000);
  assert.equal(replacement.codAmount, 1226);
});

test('16,000 → 15,800: a difference smaller than the costs goes on the COD, 1,018', async () => {
  const ctx = await setup();
  const original = await delivered(ctx, 16000);
  const replacement = await exchange(ctx, original, 15800);
  // −200 + 908.25 + 268.25 = 976.50 → grossed up for 4 %.
  assert.equal(replacement.codAmount, 1018);
});

test('a dearer swap: the customer pays the difference and both costs directly; no COD', async () => {
  const ctx = await setup();
  const original = await delivered(ctx, 12000);
  const body = { items: [line(ctx, 16000, 1)] };
  await assert.rejects(
    runHandler(swapOrder, { resource: original, body: orderSwapSchema.parse(body) }),
    /courier costs to you directly/
  );
  const out = await runHandler(swapOrder, {
    resource: await Order.findById(original._id),
    body: orderSwapSchema.parse({ ...body, differenceAccount: ctx.cash })
  });
  const replacement = await Order.findById(out.body.data._id);
  assert.equal(replacement.codAmount, 0, 'the rider collects nothing on a swap');
  // 4,000 + original 268.25 + 480.00 + the swap's own 268.25 (no COD, so no tax on it) = 5,016.50, paid to us.
  const advance = replacement.customerMoney.find(m => m.kind === 'advance');
  assert.equal(advance.amountPaisa, 501650);
});

test('a replacement cancelled before it goes out gives its costs back — the original’s still come off the refund', async () => {
  const ctx = await setup();
  const original = await delivered(ctx, 12000);
  let replacement = await exchange(ctx, original, 16000);
  assert.ok((await keptNet(ctx)) < 0, 'costs were kept back when it was made');

  replacement = await setStatus(replacement, { status: 'cancelled' });
  assert.equal(await keptNet(ctx), 0, 'the kept entry was reversed');
  assert.equal(replacement.courierCosts?.settledAt, undefined);
  assert.equal(replacement.customerMoney.filter(m => m.kind === 'kept').length, 0);
  assert.equal(
    replacement.refundDuePaisa,
    1200000,
    'the customer is owed the whole credit before costs'
  );
});

test('the quote says what the customer will owe or be owed, before the replacement is made', async () => {
  const ctx = await setup();
  const original = await delivered(ctx, 16000);
  const quote = async (total, swap = false) =>
    (
      await runHandler(getExchangeQuote, {
        resource: original,
        query: { total: String(total), swap: String(swap) }
      })
    ).body.data;

  const cheaper = await quote(12000);
  assert.equal(cheaper.owes, false);
  assert.equal(cheaper.estimatedPayout, 2823.5, '4,000 − 908.25 − 268.25');

  const same = await quote(16000);
  assert.equal(same.owes, true);
  assert.equal(same.cod, 1226);
  assert.equal(same.keep, 1226);
  assert.ok(same.lines.length >= 4);

  const swap = await quote(16000, true);
  assert.equal(swap.cod, 0);
  assert.equal(swap.pays, 1176.5, 'both parcels, the tax only on the original');

  await assert.rejects(
    runHandler(getExchangeQuote, { resource: original, query: { total: 'x' } }),
    /replacement total/
  );
});

test('only an admin can waive the deductions, and the reason is kept', async () => {
  const ctx = await setup();
  const original = await delivered(ctx, 16000);
  const replacement = await exchange(ctx, original, 12000);
  const staff = { id: userId, role: { fullAccess: false, permissions: [] } };
  const admin = { id: userId, role: { fullAccess: true } };
  await assert.rejects(
    runHandler(waiveCourierCosts, {
      resource: replacement,
      user: staff,
      body: { reason: 'faulty' }
    }),
    /Only an admin/
  );
  await runHandler(waiveCourierCosts, {
    resource: replacement,
    user: admin,
    body: { reason: 'faulty item' }
  });
  const fresh = await Order.findById(replacement._id);
  assert.equal(fresh.courierCosts.waived, true);
  assert.equal(fresh.courierCosts.reason, 'faulty item');
});
