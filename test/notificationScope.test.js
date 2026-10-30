import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, makeBusiness, runHandler } from './helpers/db.js';
import { notify } from '../utils/notify.js';
import { getNotifications, getUnreadCount } from '../controllers/notificationController.js';

/**
 * A person sees the notifications of the businesses they are assigned to — and only those — and each one says
 * which business it belongs to, so the app can switch to it when it is opened.
 */
before(connect);
after(disconnect);
afterEach(clear);

const twoBusinesses = async () => {
  const a = await makeBusiness({ name: 'Notify Shop A' });
  const b = await makeBusiness({ name: 'Notify Shop B' });
  await notify({ business: a._id, type: 'new-order', title: 'Order for A', link: '/orders/1' });
  await notify({ business: b._id, type: 'new-order', title: 'Order for B', link: '/orders/2' });
  return { a, b };
};

test('a user assigned to one business sees only that business and its id on each row', async () => {
  const { a } = await twoBusinesses();
  const req = { accessFilter: { business: { $in: [a._id] } } };

  const { body } = await runHandler(getNotifications, { ...req, query: {} });
  assert.deepEqual(
    body.data.map(n => n.title),
    ['Order for A']
  );
  assert.equal(String(body.data[0].business), String(a._id));
  assert.deepEqual((await runHandler(getUnreadCount, req)).body.data, { count: 1 });
});

test('a user assigned to both sees both, each with its own business id', async () => {
  const { a, b } = await twoBusinesses();
  const req = { accessFilter: { business: { $in: [a._id, b._id] } } };

  const { body } = await runHandler(getNotifications, { ...req, query: {} });
  assert.equal(body.data.length, 2);
  assert.deepEqual(
    new Set(body.data.map(n => String(n.business))),
    new Set([String(a._id), String(b._id)])
  );
});

test('an admin (no filter) sees every business', async () => {
  await twoBusinesses();
  const { body } = await runHandler(getNotifications, { accessFilter: {}, query: {} });
  assert.equal(body.data.length, 2);
});
