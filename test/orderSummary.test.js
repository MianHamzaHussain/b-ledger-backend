import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, makeBusiness, runHandler, oid, userId } from './helpers/db.js';
import Order from '../models/Order.js';
import { orderSummary } from '../utils/orderSummary.js';
import { getOrderSummary } from '../controllers/orderController.js';

/**
 * The Orders screen's strip: dispatched / delivered today by the day the event happened (a
 * Pakistan day), pending as everything still pending whatever its date, scoped to a business.
 */
before(connect);
after(disconnect);
afterEach(clear);

// 10:00 PKT on 2026-10-25 — mid-day, so "today" is unambiguous.
const NOW = new Date('2026-10-25T05:00:00Z');

const make = async (biz, over = {}) => {
  const { createdAt, dispatchedAt, deliveredAt, status, ...rest } = over;
  const order = new Order({
    customer: oid(),
    business: biz._id,
    customerName: 'Sana',
    contactNumber: '03001112222',
    items: [
      {
        product: oid(),
        variantId: oid(),
        productName: 'Kurta',
        quantity: 1,
        unitPrice: 1000,
        unitCost: 500
      }
    ],
    createdBy: userId,
    ...rest
  });
  await order.save();
  // Dates are set after save, so the model's own hooks can not overwrite them.
  await Order.collection.updateOne(
    { _id: order._id },
    {
      $set: {
        ...(createdAt && { createdAt }),
        ...(dispatchedAt && { dispatchedAt }),
        ...(deliveredAt && { deliveredAt }),
        ...(status && { status })
      }
    }
  );
  return order;
};

test('counts today by the day each thing happened, in Pakistan time', async () => {
  const biz = await makeBusiness();
  await make(biz, { createdAt: NOW });
  await make(biz, { status: 'dispatched', dispatchedAt: NOW, createdAt: NOW });
  await make(biz, {
    status: 'delivered',
    dispatchedAt: new Date('2026-10-24T05:00:00Z'), // yesterday
    deliveredAt: NOW
  });
  // 00:30 PKT today is 19:30Z yesterday — still today's number.
  await make(biz, { status: 'dispatched', dispatchedAt: new Date('2026-10-24T19:30:00Z') });
  // 23:59 PKT yesterday is 18:59Z — not today.
  await make(biz, { status: 'dispatched', dispatchedAt: new Date('2026-10-24T18:59:00Z') });

  const out = await orderSummary(biz._id, NOW);
  assert.equal(out.dispatchedToday, 2);
  assert.equal(out.deliveredToday, 1);
});

test('pending is every pending order, whatever its date, and byStatus lists them all', async () => {
  const biz = await makeBusiness();
  await make(biz, { createdAt: new Date('2026-08-01T05:00:00Z') });
  await make(biz, { createdAt: NOW });
  await make(biz, { status: 'confirmed' });
  const out = await orderSummary(biz._id, NOW);
  assert.equal(out.pending, 2);
  assert.deepEqual(out.byStatus, { pending: 2, confirmed: 1 });
});

test('only that business is counted', async () => {
  const mine = await makeBusiness();
  const other = await makeBusiness({ name: 'Other' });
  await make(other, { createdAt: NOW });
  assert.equal((await orderSummary(mine._id, NOW)).pending, 0);
});

test('the route needs a business, and an out-of-scope one looks like it does not exist', async () => {
  const biz = await makeBusiness();
  await assert.rejects(runHandler(getOrderSummary, { query: {} }), /Select a business/);
  await assert.rejects(
    runHandler(getOrderSummary, {
      query: { business: String(biz._id) },
      accessFilter: { business: { $in: [oid()] } }
    }),
    /not found/
  );
  const ok = await runHandler(getOrderSummary, {
    query: { business: String(biz._id) },
    accessFilter: { business: { $in: [biz._id] } }
  });
  assert.equal(ok.body.success, true);
});
