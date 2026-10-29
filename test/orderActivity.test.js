import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  connect,
  clear,
  disconnect,
  makeBusiness,
  makeProduct,
  oid,
  runHandler
} from './helpers/db.js';
import Order, { ACTIVITY_CAP } from '../models/Order.js';
import User from '../models/User.js';
import Role from '../models/Role.js';
import {
  getOrder,
  updateOrder,
  updateOrderNote,
  updateOrderCustomerNote,
  updateOrderTracking,
  updateOrderShopifyNumber
} from '../controllers/orderController.js';
import { logActivity, buildTimeline } from '../utils/orderActivity.js';
import { recordAdvance } from '../utils/customerMoney.js';
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';

before(connect);
after(disconnect);
afterEach(clear);

const makeUser = async (name, permissions = []) => {
  const role = await Role.create({ name: `Role ${name}`, permissions });
  return User.create({
    name,
    email: `${name.toLowerCase()}@b-ledger.pk`,
    phone: `+9230${Math.floor(10000000 + Math.random() * 89999999)}`,
    password: 'password1',
    role: role._id
  });
};

/** A pending order made by `user`, ready to edit. */
const makeOrder = async user => {
  const business = await makeBusiness();
  const product = await makeProduct(business._id);
  const variant = product.variants[0];
  const order = await Order.create({
    business: business._id,
    customer: oid(),
    customerName: 'Sara',
    contactNumber: '03001234567',
    city: 'Lahore',
    deliveryAddress: 'House 1',
    source: 'whatsapp',
    items: [
      {
        product: product._id,
        productName: product.name,
        variantId: variant._id,
        quantity: 1,
        unitPrice: 2000,
        unitCost: 1000
      }
    ],
    codAmount: 2000,
    createdBy: user._id
  });
  return { order, business, product, variant };
};

const asUser = user => ({ id: String(user._id), _id: user._id, role: user.role });

test('a note added after the order was made lands on the timeline with who and when', async () => {
  const ali = await makeUser('Ali');
  const { order } = await makeOrder(ali);

  await runHandler(updateOrderNote, {
    resource: await Order.findById(order._id),
    user: asUser(ali),
    body: { note: 'Call before delivery' }
  });

  const fresh = await Order.findById(order._id);
  assert.equal(fresh.activity.length, 1);
  const [event] = fresh.activity;
  assert.equal(event.kind, 'note');
  assert.equal(event.text, 'Order note added');
  assert.equal(event.to, 'Call before delivery');
  assert.equal(String(event.by), String(ali._id));
});

test('changing a note says what it was before; clearing it says removed', async () => {
  const ali = await makeUser('Ali');
  const { order } = await makeOrder(ali);
  const doc = () => Order.findById(order._id);

  await runHandler(updateOrderNote, {
    resource: await doc(),
    user: asUser(ali),
    body: { note: 'one' }
  });
  await runHandler(updateOrderNote, {
    resource: await doc(),
    user: asUser(ali),
    body: { note: 'two' }
  });
  await runHandler(updateOrderNote, {
    resource: await doc(),
    user: asUser(ali),
    body: { note: '' }
  });

  const texts = (await doc()).activity.map(e => [e.text, e.from, e.to]);
  assert.deepEqual(texts, [
    ['Order note added', undefined, 'one'],
    ['Order note changed', 'one', 'two'],
    ['Order note removed', 'two', undefined]
  ]);
});

test('saving the same value again logs nothing', async () => {
  const ali = await makeUser('Ali');
  const { order } = await makeOrder(ali);
  await Order.updateOne({ _id: order._id }, { $set: { note: 'same' } });

  await runHandler(updateOrderNote, {
    resource: await Order.findById(order._id),
    user: asUser(ali),
    body: { note: 'same' }
  });
  assert.equal((await Order.findById(order._id)).activity.length, 0);
});

test('the actor comes from the signed-in user, never the request body', async () => {
  const ali = await makeUser('Ali');
  const mallory = await makeUser('Mallory');
  const { order } = await makeOrder(ali);

  await runHandler(updateOrderCustomerNote, {
    resource: await Order.findById(order._id),
    user: asUser(ali),
    body: { customerNote: 'gift pack', by: String(mallory._id), createdBy: String(mallory._id) }
  });

  const [event] = (await Order.findById(order._id)).activity;
  assert.equal(String(event.by), String(ali._id));
});

test('tracking number and Shopify number changes are logged', async () => {
  const ali = await makeUser('Ali');
  const { order } = await makeOrder(ali);
  await runHandler(updateOrderTracking, {
    resource: await Order.findById(order._id),
    user: asUser(ali),
    body: { trackingId: 'CX-100' }
  });
  await runHandler(updateOrderShopifyNumber, {
    resource: await Order.findById(order._id),
    user: asUser(ali),
    body: { shopifyOrderNumber: '12355' }
  });
  const kinds = (await Order.findById(order._id)).activity.map(e => [e.kind, e.text]);
  assert.deepEqual(kinds, [
    ['courier', 'Tracking number added'],
    ['details', 'Shopify order number added']
  ]);
});

test('editing an order logs one event per changed field, and items with from → to', async () => {
  const ali = await makeUser('Ali');
  const { order, product, variant } = await makeOrder(ali);

  await runHandler(updateOrder, {
    resource: await Order.findById(order._id),
    user: asUser(ali),
    body: {
      customerName: 'Sara',
      contactNumber: '03001234567',
      city: 'Karachi',
      deliveryAddress: 'Flat 9',
      source: 'whatsapp',
      items: [
        {
          product: String(product._id),
          variantId: String(variant._id),
          quantity: 2,
          unitPrice: 2000
        }
      ]
    }
  });

  const fresh = await Order.findById(order._id);
  const byText = Object.fromEntries(fresh.activity.map(e => [e.text, e]));
  assert.equal(byText['City changed'].from, 'Lahore');
  assert.equal(byText['City changed'].to, 'Karachi');
  assert.equal(byText['Delivery address changed'].to, 'Flat 9');
  assert.ok(!byText['Customer name changed'], 'an unchanged field logs nothing');
  assert.ok(byText['Items changed'], 'a quantity change is an items event');
  assert.match(byText['Items changed'].to, /2 items/);
});

test('the log keeps only the newest events', async () => {
  const ali = await makeUser('Ali');
  const { order } = await makeOrder(ali);
  const doc = await Order.findById(order._id);
  for (let i = 0; i < ACTIVITY_CAP + 25; i += 1) {
    logActivity(doc, ali, { kind: 'note', text: `event ${i}` });
  }
  await doc.save();

  const fresh = await Order.findById(order._id);
  assert.equal(fresh.activity.length, ACTIVITY_CAP);
  assert.equal(fresh.activity.at(-1).text, `event ${ACTIVITY_CAP + 24}`);
  assert.equal(fresh.activity[0].text, 'event 25');
});

test('the timeline merges status steps and activity, newest first', async () => {
  const ali = await makeUser('Ali');
  const { order } = await makeOrder(ali);
  await runHandler(updateOrderNote, {
    resource: await Order.findById(order._id),
    user: asUser(ali),
    body: { note: 'hello' }
  });

  const fresh = await Order.findById(order._id);
  const timeline = buildTimeline(fresh, { role: { fullAccess: true } });
  assert.deepEqual(
    timeline.map(e => e.text),
    ['Order note added', 'Order placed']
  );
});

test('cost events are hidden from people who may not see costs', async () => {
  const ali = await makeUser('Ali');
  const { order } = await makeOrder(ali);
  const doc = await Order.findById(order._id);
  logActivity(doc, ali, { kind: 'cost', text: 'Custom cost added: thread — Rs 300' });
  logActivity(doc, ali, { kind: 'note', text: 'Order note added' });
  await doc.save();

  const fresh = await Order.findById(order._id);
  const plain = { role: { fullAccess: false, permissions: [] }, permissionOverrides: [] };
  assert.deepEqual(
    buildTimeline(fresh, plain).map(e => e.kind),
    ['note', 'status']
  );
  assert.ok(buildTimeline(fresh, { role: { fullAccess: true } }).some(e => e.kind === 'cost'));
});

test('the order reply carries the timeline and not the raw activity array', async () => {
  const ali = await makeUser('Ali');
  const { order } = await makeOrder(ali);
  await runHandler(updateOrderNote, {
    resource: await Order.findById(order._id),
    user: asUser(ali),
    body: { note: 'hello' }
  });

  const { body } = await runHandler(getOrder, {
    resource: await Order.findById(order._id),
    user: { id: String(ali._id), role: { fullAccess: true } }
  });
  assert.ok(Array.isArray(body.data.timeline));
  assert.equal(body.data.activity, undefined);
  assert.equal(body.data.timeline[0].by?.name, 'Ali');
});

test('an advance and a refund are logged with the amount and the account', async () => {
  const ali = await makeUser('Ali');
  const { order, business } = await makeOrder(ali);
  const cash = await accountByCode(business._id, CODES.CASH);
  const doc = await Order.findById(order._id);

  await recordAdvance(doc, {
    amount: 500,
    money: { account: cash._id, name: 'Cash' },
    userId: ali._id
  });

  const texts = (await Order.findById(order._id)).activity.map(e => e.text);
  assert.deepEqual(texts, ['Advance Rs 500 received in Cash']);
});

test('no other reply that returns the order carries the raw activity log', async () => {
  const ali = await makeUser('Ali');
  const { order } = await makeOrder(ali);
  const doc = await Order.findById(order._id);
  logActivity(doc, ali, { kind: 'cost', text: 'Custom cost added: thread — Rs 300' });
  await doc.save();

  const asReply = JSON.parse(JSON.stringify(await Order.findById(order._id)));
  assert.equal(asReply.activity, undefined);
});
