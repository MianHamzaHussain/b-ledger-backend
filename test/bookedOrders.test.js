import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  connect,
  clear,
  disconnect,
  makeBusiness,
  makeProduct,
  runHandler,
  userId
} from './helpers/db.js';
import Order from '../models/Order.js';
import Product from '../models/Product.js';
import Notification from '../models/Notification.js';
import '../models/Category.js';
import {
  createOrder,
  updateOrderStatus,
  updateOrderBookedFor
} from '../controllers/orderController.js';
import { orderCreateSchema, orderStatusSchema, orderBookedForSchema } from '../schemas/orders.js';
import { ORDER_TRANSITIONS } from '../utils/constants.js';
import { runBookingReminders } from '../utils/bookingReminders.js';
import { pakistanDay } from '../utils/pakistanDay.js';

/**
 * A booked order is taken now for a later day: stock and any advance are held, it stays out of
 * the day's dispatch work, and an alert fires — once a day — when its day arrives.
 */
before(connect);
after(disconnect);
afterEach(clear);

const admin = { id: userId, role: { fullAccess: true } };
const future = () => {
  const d = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000);
  return pakistanDay(d);
};

let n = 0;
const place = async (extra = {}) => {
  const biz = await makeBusiness({ name: `Shop ${(n += 1)}` });
  const product = await makeProduct(biz._id);
  const out = await runHandler(createOrder, {
    user: admin,
    body: orderCreateSchema.parse({
      business: String(biz._id),
      customerName: 'Sana',
      contactNumber: '03004445555',
      items: [
        {
          product: String(product._id),
          variantId: String(product.variants[0]._id),
          quantity: 2,
          unitPrice: 2000
        }
      ],
      ...extra
    })
  });
  return { biz, product, order: await Order.findById(out.body.data._id) };
};

const stockOf = async product => (await Product.findById(product._id)).variants[0].stock;

test('an order with a due day is booked, and holds its stock', async () => {
  const day = future();
  const { product, order } = await place({ bookedFor: day });
  assert.equal(order.status, 'booked');
  assert.equal(order.bookedFor, day);
  assert.equal(await stockOf(product), 48, 'the two pieces are held');
});

test('a day that has already passed is refused, and nothing is taken', async () => {
  const biz = await makeBusiness();
  const product = await makeProduct(biz._id);
  await assert.rejects(
    runHandler(createOrder, {
      user: admin,
      body: orderCreateSchema.parse({
        business: String(biz._id),
        customerName: 'Sana',
        contactNumber: '03004445555',
        bookedFor: '2020-01-01',
        items: [
          {
            product: String(product._id),
            variantId: String(product.variants[0]._id),
            quantity: 1,
            unitPrice: 1
          }
        ]
      })
    }),
    /already passed/
  );
  assert.equal(await stockOf(product), 50);
});

test('the status table lets a booked order be released, dispatched or cancelled', () => {
  assert.deepEqual(ORDER_TRANSITIONS.booked.sort(), [
    'cancelled',
    'confirmed',
    'dispatched',
    'pending'
  ]);
  assert.ok(ORDER_TRANSITIONS.pending.includes('booked'));
  assert.ok(ORDER_TRANSITIONS.confirmed.includes('booked'));
});

test('cancelling a booked order gives the stock back', async () => {
  const { product, order } = await place({ bookedFor: future() });
  await runHandler(updateOrderStatus, {
    user: admin,
    resource: order,
    body: orderStatusSchema.parse({ status: 'cancelled' })
  });
  assert.equal(await stockOf(product), 50);
});

test('an existing order can be booked, but only with a day', async () => {
  const { order } = await place();
  await assert.rejects(
    runHandler(updateOrderStatus, {
      user: admin,
      resource: order,
      body: orderStatusSchema.parse({ status: 'booked' })
    }),
    /Choose the day/
  );
  const day = future();
  await runHandler(updateOrderStatus, {
    user: admin,
    resource: await Order.findById(order._id),
    body: orderStatusSchema.parse({ status: 'booked', bookedFor: day })
  });
  assert.equal((await Order.findById(order._id)).bookedFor, day);
});

test('the due day can be moved while booked, not otherwise', async () => {
  const { order } = await place({ bookedFor: future() });
  const later = pakistanDay(new Date(Date.now() + 60 * 24 * 60 * 60 * 1000));
  await runHandler(updateOrderBookedFor, {
    user: admin,
    resource: order,
    body: orderBookedForSchema.parse({ bookedFor: later })
  });
  assert.equal((await Order.findById(order._id)).bookedFor, later);

  const plain = (await place()).order;
  await assert.rejects(
    runHandler(updateOrderBookedFor, {
      user: admin,
      resource: plain,
      body: orderBookedForSchema.parse({ bookedFor: later })
    }),
    /Only a booked order/
  );
});

// ── the reminder job ────────────────────────────────────────────────────────

// 10:00 PKT on a fixed day, and the day itself.
const TEN_AM = new Date('2026-12-19T05:00:00Z');
const DAY = '2026-12-19';

const booked = async (bookedFor, status = 'booked') => {
  const { order, biz } = await place();
  await Order.collection.updateOne({ _id: order._id }, { $set: { status, bookedFor } });
  return { order, biz };
};

test('on its day an order is alerted once, not again the same day', async () => {
  const { order } = await booked(DAY);
  assert.deepEqual(await runBookingReminders(TEN_AM), { checked: 1, alerted: 1 });
  assert.deepEqual(await runBookingReminders(TEN_AM), { checked: 0, alerted: 0 });

  const notes = await Notification.find({ type: 'booking-due' });
  assert.equal(notes.length, 1);
  assert.match(notes[0].title, /due today/);
  assert.equal(notes[0].link, `/orders/${order._id}`);
});

test('the next day it is alerted again, as overdue, until it leaves booked', async () => {
  await booked(DAY);
  await runBookingReminders(TEN_AM);
  const tomorrow = new Date('2026-12-20T05:00:00Z');
  assert.equal((await runBookingReminders(tomorrow)).alerted, 1);
  const latest = await Notification.find({ type: 'booking-due' }).sort({ createdAt: -1 });
  assert.match(latest[0].title, /overdue/);
});

test('a future day, a released order and an early hour stay silent', async () => {
  await booked('2026-12-25');
  await booked(DAY, 'pending'); // released
  assert.equal((await runBookingReminders(TEN_AM)).alerted, 0);

  await booked(DAY);
  // 08:59 PKT is 03:59Z — before the alert hour.
  assert.equal((await runBookingReminders(new Date('2026-12-19T03:59:00Z'))).alerted, 0);
  // 09:00 PKT is 04:00Z.
  assert.equal((await runBookingReminders(new Date('2026-12-19T04:00:00Z'))).alerted, 1);
});

test('two runs at once alert an order only once', async () => {
  await booked(DAY);
  const [a, b] = await Promise.all([runBookingReminders(TEN_AM), runBookingReminders(TEN_AM)]);
  assert.equal(a.alerted + b.alerted, 1);
  assert.equal(await Notification.countDocuments({ type: 'booking-due' }), 1);
});

test('moving the day starts the alert again from the new day', async () => {
  const { order } = await booked(DAY);
  await runBookingReminders(TEN_AM);
  await Order.updateOne({ _id: order._id }, { $unset: { bookingAlertedOn: 1 } });
  assert.equal((await runBookingReminders(TEN_AM)).alerted, 1);
});
