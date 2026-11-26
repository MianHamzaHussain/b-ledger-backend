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
import JournalEntry from '../models/JournalEntry.js';
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { accountBalance } from '../utils/ledger.js';
import { applyExchangeKeep, undoExchangeCosts } from '../utils/courierCosts.js';
import { repriceExchanges } from '../utils/repriceExchanges.js';
import {
  createOrder,
  updateOrderStatus,
  exchangeReturn,
  createReplacement
} from '../controllers/orderController.js';
import { orderCreateSchema, orderStatusSchema, orderReplacementSchema } from '../schemas/orders.js';

/**
 * The one-off that re-works exchanges made under the old rule (both parcels) that have not gone out yet: the owner's
 * #0546 (15,000 → 15,300) was COD 1,497 and becomes 592. A dispatched one is never touched.
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
  return { biz, product, courier };
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

async function delivered(ctx, price) {
  seq += 1;
  const out = await runHandler(createOrder, {
    body: orderCreateSchema.parse({
      business: String(ctx.biz._id),
      customerName: 'Zeeshan',
      contactNumber: '03324366232',
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

/** A replacement as the OLD code left it: both parcels kept back (1,197 here), COD 1,497, no rule on it. */
async function oldRuleReplacement(ctx) {
  const original = await delivered(ctx, 15000);
  await runHandler(exchangeReturn, { resource: original, body: {} });
  const out = await runHandler(createReplacement, {
    resource: await Order.findById(original._id),
    body: orderReplacementSchema.parse({ items: [line(ctx, 15300, 1)] })
  });
  let replacement = await Order.findById(out.body.data._id);
  await undoExchangeCosts(replacement, userId);
  await replacement.save();
  await applyExchangeKeep(
    replacement,
    {
      keepPaisa: 119700,
      lines: [
        { label: 'Delivery charge — parcel #old', amountPaisa: 26825, source: 'receipt' },
        { label: '4 % tax on COD — parcel #old', amountPaisa: 60000, source: 'receipt' },
        { label: 'Delivery charge — replacement parcel', amountPaisa: 26825, source: 'estimate' },
        { label: '4 % tax on COD — replacement parcel', amountPaisa: 5988, source: 'estimate' },
        { label: 'Rounding to the rupee', amountPaisa: 62, source: 'estimate' }
      ]
    },
    userId
  );
  await Order.collection.updateOne({ _id: replacement._id }, { $unset: { exchangeCostRule: '' } });
  replacement = await Order.findById(replacement._id);
  assert.equal(replacement.codAmount, 1497, 'set up as the old code made it');
  return replacement;
}

const kept = async ctx =>
  accountBalance(ctx.biz._id, (await accountByCode(ctx.biz._id, CODES.CHARGES_KEPT))._id);

test('dry run lists the old-rule replacement and changes nothing', async () => {
  const ctx = await setup();
  const replacement = await oldRuleReplacement(ctx);
  const entries = await JournalEntry.countDocuments();

  const { changes } = await repriceExchanges();
  assert.equal(changes.length, 1);
  assert.equal(changes[0].orderNumber, replacement.orderNumber);
  assert.equal(changes[0].codBefore, 1497);
  assert.equal(changes[0].codAfter, 592);
  assert.equal((await Order.findById(replacement._id)).codAmount, 1497);
  assert.equal(await JournalEntry.countDocuments(), entries, 'nothing posted');
});

test('apply: COD 1,497 → 592, only the new parcel kept back, books balance, timeline says so; a second run finds nothing', async () => {
  const ctx = await setup();
  const replacement = await oldRuleReplacement(ctx);
  assert.equal(await kept(ctx), -119700);

  await repriceExchanges({ apply: true });
  const fresh = await Order.findById(replacement._id);
  assert.equal(fresh.codAmount, 592);
  assert.equal(fresh.exchangeCostRule, 'new-parcel');
  assert.equal(await kept(ctx), -29200, '592 − 300: the new parcel and its 4 %, rounded');
  assert.ok(fresh.customerMoney.every(m => !(m.accountName || '').includes('#old')));
  assert.ok(fresh.activity.some(a => a.text.startsWith('Exchange costs worked out again')));
  for (const e of await JournalEntry.find({ business: ctx.biz._id })) {
    const debit = e.lines.reduce((s, l) => s + l.debitPaisa, 0);
    const credit = e.lines.reduce((s, l) => s + l.creditPaisa, 0);
    assert.equal(debit, credit, `"${e.memo}" balances`);
  }

  assert.deepEqual((await repriceExchanges({ apply: true })).changes, []);
});

test('a dispatched old-rule replacement is left alone — its COD is on the courier slip', async () => {
  const ctx = await setup();
  let replacement = await oldRuleReplacement(ctx);
  replacement = await setStatus(replacement, {
    status: 'dispatched',
    courier: String(ctx.courier._id),
    trackingId: 'TRK-OUT'
  });
  const { changes } = await repriceExchanges({ apply: true });
  assert.deepEqual(changes, []);
  assert.equal((await Order.findById(replacement._id)).codAmount, 1497);
});
