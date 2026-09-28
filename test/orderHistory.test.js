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
import { updateOrderStatus, updateOrderNote, getOrder } from '../controllers/orderController.js';
import { orderNoteSchema, orderStatusSchema } from '../schemas/orders.js';
import { pakistanDay } from '../utils/pakistanDay.js';

/**
 * Every status change is logged with who, when and an optional reason; each
 * order also gets "today's #N", restarting per business and per Pakistan day.
 */

before(connect);
after(disconnect);
afterEach(clear);

const newOrder = async (biz, product) =>
  Order.create({
    business: biz._id,
    customer: oid(),
    customerName: 'Fatima',
    contactNumber: '03331234567',
    items: [
      {
        product: product._id,
        variantId: product.variants[0]._id,
        productName: product.name,
        quantity: 1,
        unitPrice: 2000,
        unitCost: 1000
      }
    ],
    createdBy: userId
  });

const setStatus = (order, body) =>
  runHandler(updateOrderStatus, {
    resource: order,
    body: orderStatusSchema.parse(body),
    user: { id: userId }
  });

test('a Pakistan day turns over at midnight Pakistan time, not UTC', () => {
  // 19:30 UTC is 00:30 the next morning in Pakistan.
  assert.equal(pakistanDay(new Date('2026-09-26T19:30:00Z')), '2026-09-27');
  assert.equal(pakistanDay(new Date('2026-09-26T18:59:00Z')), '2026-09-26');
});

test('each business counts its own orders for the day from 1', async () => {
  // Business names are unique, so the second one needs its own.
  const lawn = await makeBusiness({ name: 'Qamar Lawn' });
  const noor = await makeBusiness({ name: 'Noor Cosmetics' });
  const lawnProduct = await makeProduct(lawn._id);
  const noorProduct = await makeProduct(noor._id);

  const a = await newOrder(lawn, lawnProduct);
  const b = await newOrder(lawn, lawnProduct);
  const c = await newOrder(noor, noorProduct);

  assert.deepEqual([a.dailySerial, b.dailySerial, c.dailySerial], [1, 2, 1]);
  assert.equal(a.orderDay, pakistanDay());
  assert.notEqual(a.orderNumber, b.orderNumber, 'the permanent number still never repeats');
});

test('a new order starts its timeline as pending, by whoever created it', async () => {
  const biz = await makeBusiness();
  const order = await newOrder(biz, await makeProduct(biz._id));

  assert.equal(order.statusHistory.length, 1);
  assert.equal(order.statusHistory[0].status, 'pending');
  assert.equal(String(order.statusHistory[0].by), String(userId));
});

test('a status change logs its reason and stamps its date', async () => {
  const biz = await makeBusiness();
  const courier = await makeParty(biz._id, 'courier');
  const order = await newOrder(biz, await makeProduct(biz._id));

  const out = await setStatus(order, {
    status: 'dispatched',
    courier: String(courier._id),
    trackingId: 'TCS1',
    note: '  Sent with the evening pickup  '
  });
  const saved = out.body.data;

  const last = saved.statusHistory.at(-1);
  assert.equal(last.status, 'dispatched');
  assert.equal(last.note, 'Sent with the evening pickup');
  assert.ok(saved.dispatchedAt instanceof Date);

  // No reason is fine — the change is still logged, without a note.
  const returned = await setStatus(await Order.findById(saved._id), {
    status: 'returned',
    deliveryCharge: 0
  });
  assert.equal(returned.body.data.statusHistory.at(-1).note, undefined);
  assert.equal(returned.body.data.statusHistory.length, 3);
  assert.ok(returned.body.data.returnedAt instanceof Date);
});

test('the order note can be set at any status and changes nothing else', async () => {
  const biz = await makeBusiness();
  const order = await newOrder(biz, await makeProduct(biz._id));
  order.status = 'delivered';
  await order.save();

  const out = await runHandler(updateOrderNote, {
    resource: order,
    body: orderNoteSchema.parse({ note: 'Customer asked for a call before delivery' }),
    user: { id: userId }
  });
  assert.equal(out.body.data.note, 'Customer asked for a call before delivery');
  assert.equal(out.body.data.status, 'delivered');
  assert.equal(out.body.data.statusHistory.length, 2, 'a note is not a status change');
});

test('an order not yet dispatched is collected on delivery, not shop credit', async () => {
  const biz = await makeBusiness();
  const product = await makeProduct(biz._id);
  // A WhatsApp order has no courier until dispatch — it is still a COD order.
  const whatsapp = await newOrder(biz, product);
  whatsapp.source = 'whatsapp';
  await whatsapp.save();
  const pending = await runHandler(getOrder, { resource: whatsapp });
  assert.equal(pending.body.data.remittance.counterSale, false);

  // Only a walk-in with no courier is a shop sale the customer owes on credit.
  const walkIn = await newOrder(biz, product);
  walkIn.source = 'walk-in';
  await walkIn.save();
  const counter = await runHandler(getOrder, { resource: walkIn });
  assert.equal(counter.body.data.remittance.counterSale, true);
});
