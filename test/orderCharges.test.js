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
  oid,
  userId
} from './helpers/db.js';
import Order from '../models/Order.js';
import JournalEntry from '../models/JournalEntry.js';
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { updateOrderStatus } from '../controllers/orderController.js';
import { orderExchangeSchema, orderStatusSchema } from '../schemas/orders.js';
import { toPaisa } from '../utils/money.js';

/**
 * The courier's charge is taken at the parcel's OUTCOME (delivered / returned /
 * exchanged), not at dispatch — it depends on weight, city and what happened.
 * Dispatch takes only the courier and its tracking number.
 */

before(connect);
after(disconnect);
afterEach(clear);

async function makeOrder(status = 'pending') {
  const biz = await makeBusiness();
  const courier = await makeParty(biz._id, 'courier');
  const product = await makeProduct(biz._id);
  const variant = product.variants[0];
  const order = await Order.create({
    business: biz._id,
    customer: oid(),
    customerName: 'Ali',
    contactNumber: '03001234567',
    items: [
      {
        product: product._id,
        variantId: variant._id,
        productName: product.name,
        quantity: 1,
        unitPrice: 2000,
        unitCost: 1000
      }
    ],
    courier: status === 'pending' ? undefined : courier._id,
    status,
    createdBy: userId
  });
  return { biz, courier, order };
}

const setStatus = (order, body) =>
  runHandler(updateOrderStatus, { resource: order, body: orderStatusSchema.parse(body) });

test('dispatch requires a tracking number and takes no charge', async () => {
  const { courier, order } = await makeOrder();

  await assert.rejects(
    setStatus(order, { status: 'dispatched', courier: String(courier._id) }),
    /tracking number/
  );

  const out = await setStatus(order, {
    status: 'dispatched',
    courier: String(courier._id),
    trackingId: ' TCS123 ',
    deliveryCharge: 250 // ignored — not known yet
  });
  assert.equal(out.body.data.trackingId, 'TCS123');
  assert.equal(out.body.data.deliveryChargePaisa, undefined, 'no charge booked at dispatch');
});

test('delivered requires the charge and books it into the sale', async () => {
  const { biz, order } = await makeOrder('dispatched');

  await assert.rejects(setStatus(order, { status: 'delivered' }), /charge/);
  await assert.rejects(
    setStatus(order, { status: 'delivered', deliveryCharge: 2500 }),
    /exceed the COD/
  );

  const out = await setStatus(order, { status: 'delivered', deliveryCharge: 180 });
  assert.equal(out.body.data.deliveryChargePaisa, toPaisa(180));

  const sale = await JournalEntry.findById(out.body.data.saleEntry);
  const deliveryAcc = (await accountByCode(biz._id, CODES.DELIVERY_CHARGES))._id;
  const line = sale.lines.find(l => String(l.account) === String(deliveryAcc));
  assert.equal(line.debitPaisa, toPaisa(180), 'delivery fee expensed at delivery');
});

test('an explicit 0 delivers without a delivery-fee line', async () => {
  const { biz, order } = await makeOrder('dispatched');
  const out = await setStatus(order, { status: 'delivered', deliveryCharge: 0 });
  assert.equal(out.body.data.deliveryChargePaisa, 0);

  const sale = await JournalEntry.findById(out.body.data.saleEntry);
  const deliveryAcc = (await accountByCode(biz._id, CODES.DELIVERY_CHARGES))._id;
  assert.ok(!sale.lines.some(l => String(l.account) === String(deliveryAcc)));
});

test('returned requires the charge and books it as a return expense', async () => {
  const { biz, order } = await makeOrder('dispatched');

  await assert.rejects(setStatus(order, { status: 'returned' }), /charge/);

  // A return fee is not capped by the COD — the courier bills it regardless.
  const out = await setStatus(order, { status: 'returned', deliveryCharge: 300 });
  assert.equal(out.body.data.returnChargePaisa, toPaisa(300));
  assert.equal(out.body.data.deliveryChargePaisa, undefined);

  const returnAcc = (await accountByCode(biz._id, CODES.RETURN_CHARGES))._id;
  const entry = await JournalEntry.findOne({ business: biz._id, 'lines.account': returnAcc });
  assert.ok(entry, 'return charge posted');
  const line = entry.lines.find(l => String(l.account) === String(returnAcc));
  assert.equal(line.debitPaisa, toPaisa(300));
});

test('exchange schema requires the pickup charge', () => {
  const items = [{ product: 'p', variantId: 'v', quantity: 1, unitPrice: 100 }];
  assert.equal(orderExchangeSchema.safeParse({ items }).success, false);
  assert.equal(orderExchangeSchema.safeParse({ items, returnCharge: -1 }).success, false);
  const ok = orderExchangeSchema.safeParse({ items, returnCharge: 0 });
  assert.equal(ok.success, true);
  assert.equal(ok.data.returnCharge, 0);
});
