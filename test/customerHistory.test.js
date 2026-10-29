import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  connect,
  clear,
  disconnect,
  makeBusiness,
  makeProduct,
  runHandler,
  oid,
  userId
} from './helpers/db.js';
import Customer from '../models/Customer.js';
import Order from '../models/Order.js';
import Product from '../models/Product.js';
import {
  suggestCustomers,
  getCustomerHistory,
  setCustomerBlocked
} from '../controllers/customerController.js';
import { createOrder, updateOrder } from '../controllers/orderController.js';
import { orderCreateSchema, orderUpdateSchema } from '../schemas/orders.js';
import { customerBlockSchema } from '../schemas/customers.js';
import { customerStats } from '../utils/customerStats.js';

/**
 * Customers on the order form and in their own page: type-ahead with order counts, a history that is
 * one aggregation on an index, and a block that a person sets and the server enforces.
 */
before(connect);
after(disconnect);
afterEach(clear);

const scopedTo = (...businesses) => ({
  accessFilter: { business: { $in: businesses.map(b => b._id) } }
});

const customerOf = (biz, name, phone, extra = {}) =>
  Customer.create({ business: biz._id, name, phone, createdBy: userId, ...extra });

/** An order for `customer` in a given status, made straight in the database (no stock or posting). */
const orderFor = async (biz, product, customer, status, extra = {}) =>
  Order.create({
    business: biz._id,
    customer: customer._id,
    customerName: customer.name,
    contactNumber: customer.phone,
    deliveryAddress: 'House 5',
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
    status,
    codAmount: 2000,
    createdBy: userId,
    ...extra
  });

test('the counts say delivered, returned and cancelled apart, for the right customer only', async () => {
  const biz = await makeBusiness();
  const product = await makeProduct(biz._id);
  const sara = await customerOf(biz, 'Sara', '03001111111');
  const ali = await customerOf(biz, 'Ali', '03002222222');
  for (const status of ['delivered', 'delivered', 'returned', 'cancelled', 'dispatched']) {
    await orderFor(biz, product, sara, status);
  }
  await orderFor(biz, product, ali, 'delivered');

  const stats = (await customerStats(biz._id, [sara._id, ali._id])).get(String(sara._id));
  assert.equal(stats.orders, 5);
  assert.equal(stats.delivered, 2);
  assert.equal(stats.returned, 1);
  assert.equal(stats.cancelled, 1);
  assert.equal(stats.boughtAmount, 4000, 'only delivered orders count as bought');
  assert.equal((await customerStats(biz._id, [ali._id])).get(String(ali._id)).orders, 1);
});

test('an exchanged or refunded order still counts as delivered; a refused try is counted', async () => {
  const biz = await makeBusiness();
  const product = await makeProduct(biz._id);
  const c = await customerOf(biz, 'Hina', '03003333333');
  await orderFor(biz, product, c, 'exchanged');
  await orderFor(biz, product, c, 'refunded');
  await orderFor(biz, product, c, 'dispatched', {
    deliveryAttempts: [{ reason: 'refused' }, { reason: 'not-available' }]
  });
  const s = (await customerStats(biz._id, [c._id])).get(String(c._id));
  assert.equal(s.delivered, 2);
  assert.equal(s.refusedTries, 1);
});

test('the stats query uses the customer index, not a scan', async () => {
  const biz = await makeBusiness();
  await Order.init();
  const plan = await Order.find({ business: biz._id, customer: oid() })
    .sort({ createdAt: -1 })
    .explain('queryPlanner');
  const text = JSON.stringify(plan.queryPlanner.winningPlan);
  assert.match(text, /IXSCAN/);
  assert.match(text, /business_1_customer_1_createdAt_-1/);
});

test('type-ahead needs 3 characters, matches a name or a number typed any way, five at a time', async () => {
  const biz = await makeBusiness();
  await customerOf(biz, 'Saima Kashif', '03102273145');
  for (let i = 0; i < 6; i += 1) await customerOf(biz, `Saman ${i}`, `0300555000${i}`);

  const run = query =>
    runHandler(suggestCustomers, {
      query: { business: String(biz._id), ...query },
      ...scopedTo(biz)
    });

  assert.equal((await run({ q: 'sa' })).body.count, 0, 'two characters ask the server nothing');
  assert.equal((await run({ q: 'saima' })).body.data[0].name, 'Saima Kashif');
  for (const typed of ['0310 227', '+92 310 227', '310227']) {
    const { body } = await run({ q: typed });
    assert.equal(body.data[0]?.name, 'Saima Kashif', typed);
  }
  const first = (await run({ q: 'sam' })).body;
  assert.equal(first.count, 5);
  assert.equal(first.total, 6);
  assert.deepEqual(first.pagination.next, { page: 2, limit: 5 });
  const second = (await run({ q: 'sam', page: 2 })).body;
  assert.equal(second.count, 1);
  assert.deepEqual(second.pagination, {});
});

test('a suggestion carries names and counts and the last address, never money', async () => {
  const biz = await makeBusiness();
  const product = await makeProduct(biz._id);
  const c = await customerOf(biz, 'Mushtaq Alam', '03311374862', { city: 'Lahore' });
  await orderFor(biz, product, c, 'delivered');
  await orderFor(biz, product, c, 'returned', { deliveryAddress: 'Flat 9, Gulberg' });

  const { body } = await runHandler(suggestCustomers, {
    query: { business: String(biz._id), q: 'mushtaq' },
    ...scopedTo(biz)
  });
  const [row] = body.data;
  assert.equal(row.orders, 2);
  assert.equal(row.delivered, 1);
  assert.equal(row.returned, 1);
  assert.equal(row.lastAddress, 'Flat 9, Gulberg', 'the newest order is the source');
  assert.equal(row.city, 'Lahore');
  assert.deepEqual(
    Object.keys(row).filter(k => /amount|total|paisa|price|cost/i.test(k)),
    []
  );
});

test('suggestions never cross businesses, and outside your scope is a 404', async () => {
  const mine = await makeBusiness();
  const theirs = await makeBusiness({ name: 'Other Biz' });
  await customerOf(theirs, 'Secret Person', '03009990000');

  const own = await runHandler(suggestCustomers, {
    query: { business: String(mine._id), q: 'secret' },
    ...scopedTo(mine)
  });
  assert.equal(own.body.count, 0);

  await assert.rejects(
    runHandler(suggestCustomers, {
      query: { business: String(theirs._id), q: 'secret' },
      ...scopedTo(mine)
    }),
    err => err.statusCode === 404
  );
});

test('the history carries the counts and the orders newest first, a page at a time', async () => {
  const biz = await makeBusiness();
  const product = await makeProduct(biz._id);
  const c = await customerOf(biz, 'Armeen Syed', '03113164859');
  for (let i = 0; i < 12; i += 1) {
    await orderFor(biz, product, c, i % 4 === 0 ? 'returned' : 'delivered');
  }
  const { body } = await runHandler(getCustomerHistory, {
    resource: c,
    query: { limit: '10' }
  });
  assert.equal(body.data.stats.orders, 12);
  assert.equal(body.data.stats.returned, 3);
  assert.equal(body.data.orders.length, 10);
  assert.deepEqual(body.pagination.next, { page: 2, limit: 10 });
  assert.ok(body.data.orders[0].createdAt >= body.data.orders[9].createdAt, 'newest first');
  assert.equal(body.data.orders[0].items, undefined, 'rows are lean: no line items');
  assert.equal(body.data.stats.lastAddress, undefined);

  const page2 = await runHandler(getCustomerHistory, {
    resource: c,
    query: { page: '2', limit: '10' }
  });
  assert.equal(page2.body.data.orders.length, 2);
});

test('blocking needs a reason, is stamped from the signed-in user, and can be lifted', async () => {
  assert.equal(customerBlockSchema.safeParse({ isBlocked: true }).success, false);
  assert.equal(customerBlockSchema.safeParse({ isBlocked: true, reason: 'ab' }).success, false);
  assert.equal(
    customerBlockSchema.safeParse({ isBlocked: true, reason: 'refused 3 times' }).success,
    true
  );
  assert.equal(customerBlockSchema.safeParse({ isBlocked: false }).success, true);

  const biz = await makeBusiness();
  const c = await customerOf(biz, 'Bad Buyer', '03004440000');
  const user = { id: String(oid()) };

  await runHandler(setCustomerBlocked, {
    resource: await Customer.findById(c._id),
    user,
    body: { isBlocked: true, reason: 'refused 3 times', blockedBy: String(oid()) }
  });
  let fresh = await Customer.findById(c._id);
  assert.equal(fresh.isBlocked, true);
  assert.equal(fresh.blockedReason, 'refused 3 times');
  assert.equal(String(fresh.blockedBy), user.id, 'the actor is the token user, not the body');

  await runHandler(setCustomerBlocked, {
    resource: await Customer.findById(c._id),
    user,
    body: { isBlocked: false }
  });
  fresh = await Customer.findById(c._id);
  assert.equal(fresh.isBlocked, undefined);
  assert.equal(fresh.blockedReason, undefined);
});

const orderBody = (biz, product, extra = {}) => ({
  business: String(biz._id),
  customerName: 'Bad Buyer',
  contactNumber: '0300 444 0000',
  items: [
    {
      product: String(product._id),
      variantId: String(product.variants[0]._id),
      quantity: 1,
      unitPrice: 3000
    }
  ],
  ...extra
});

test('an order for a blocked number is refused, and nothing is reserved', async () => {
  const biz = await makeBusiness();
  const product = await makeProduct(biz._id, [
    { label: 'M', costPrice: 1000, salePrice: 2000, stock: 5 }
  ]);
  await customerOf(biz, 'Bad Buyer', '03004440000', {
    isBlocked: true,
    blockedReason: 'refused 3 times'
  });

  await assert.rejects(
    runHandler(createOrder, { body: orderCreateSchema.parse(orderBody(biz, product)) }),
    err => err.statusCode === 400 && /blocked: refused 3 times/.test(err.message)
  );
  assert.equal(await Order.countDocuments({ business: biz._id }), 0);
  assert.equal((await Product.findById(product._id)).variants[0].stock, 5, 'no stock was taken');
});

test('"create anyway" goes through and is recorded on the order, with who and why', async () => {
  const biz = await makeBusiness();
  const product = await makeProduct(biz._id);
  await customerOf(biz, 'Bad Buyer', '03004440000', {
    isBlocked: true,
    blockedReason: 'refused 3 times'
  });
  const user = { id: String(oid()) };

  const { body } = await runHandler(createOrder, {
    user,
    body: orderCreateSchema.parse(orderBody(biz, product, { confirmBlocked: true }))
  });
  const order = await Order.findById(body.data._id);
  assert.equal(String(order.blockedOverride.by), user.id);
  assert.equal(order.blockedOverride.reason, 'refused 3 times');
  assert.ok(order.blockedOverride.at);
});

test('a customer who is not blocked is unaffected, even with the tick set', async () => {
  const biz = await makeBusiness();
  const product = await makeProduct(biz._id);
  const { body } = await runHandler(createOrder, {
    body: orderCreateSchema.parse(orderBody(biz, product, { confirmBlocked: true }))
  });
  const order = await Order.findById(body.data._id);
  assert.equal(order.blockedOverride, undefined);
});

test('moving an order to a blocked number needs the same tick; an unchanged number does not', async () => {
  const biz = await makeBusiness();
  const product = await makeProduct(biz._id);
  await customerOf(biz, 'Bad Buyer', '03004440000', { isBlocked: true, blockedReason: 'refused' });
  const { body } = await runHandler(createOrder, {
    body: orderCreateSchema.parse(
      orderBody(biz, product, { customerName: 'Sana', contactNumber: '03005556666' })
    )
  });
  const edit = extra =>
    orderUpdateSchema.parse({
      customerName: 'Sana',
      contactNumber: '03005556666',
      items: orderBody(biz, product).items,
      ...extra
    });

  // Same number, no tick: fine.
  await runHandler(updateOrder, { resource: await Order.findById(body.data._id), body: edit({}) });

  // Changing it to the blocked number: refused without the tick.
  await assert.rejects(
    runHandler(updateOrder, {
      resource: await Order.findById(body.data._id),
      body: edit({ contactNumber: '03004440000' })
    }),
    err => err.statusCode === 400 && /blocked/.test(err.message)
  );
});
