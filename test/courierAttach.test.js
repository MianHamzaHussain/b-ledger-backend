import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, runHandler } from './helpers/db.js';
import Order from '../models/Order.js';
import { getCourierParcels, getLoadSheet } from '../controllers/orderController.js';
import { orderLoadSheetSchema } from '../schemas/orders.js';
import { courierDeps } from '../utils/couriers/index.js';
import { clearCityCache } from '../utils/couriers/booking.js';
import { admin, fakePostex, restoreFetch, setupOrder, dispatchBooked } from './helpers/courier.js';

/**
 * A parcel already made on the courier's own site is picked from a list matched on the customer's
 * phone, not pasted. Attaching it leaves the same booking record as booking through the app, so the
 * status check follows it from there.
 */
before(connect);
after(disconnect);
afterEach(async () => {
  restoreFetch();
  clearCityCache();
  await clear();
});

const theirs = (n, phone = '03001234567') => ({
  trackingNumber: n,
  customerPhone: phone,
  customerName: 'Someone',
  orderRefNumber: 'X1',
  cityName: 'Lahore',
  invoicePayment: 4000
});

const track = status => ({ transactionStatus: status });

test('lists the courier’s unbooked parcels for this customer’s phone, and only those', async () => {
  fakePostex({ unbooked: [theirs('CX-7001'), theirs('CX-7002', '03451112223')] });
  const { order, courier } = await setupOrder({ phone: '+92 300 1234567' });
  const out = await runHandler(getCourierParcels, {
    user: admin,
    resource: order,
    query: { courier: String(courier._id) }
  });
  assert.deepEqual(
    out.body.data.map(p => p.trackingNumber),
    ['CX-7001']
  );
});

test('a parcel already attached to another order is not offered again', async () => {
  fakePostex({
    unbooked: [theirs('CX-7001')],
    tracking: { 'CX-7001': track('Unbooked') }
  });
  const { order, courier } = await setupOrder();
  await dispatchBooked(order, courier, { bookWithCourier: false, attachCourierParcel: 'CX-7001' });

  const second = await setupOrder({ name: 'Other Shop' });
  const out = await runHandler(getCourierParcels, {
    user: admin,
    resource: second.order,
    query: { courier: String(second.courier._id) }
  });
  assert.equal(out.body.data.length, 0);
});

test('attaching saves the same booking record, so the status check follows it', async () => {
  fakePostex({ tracking: { 'CX-7001': track('Unbooked') } });
  const { order, courier } = await setupOrder();
  await dispatchBooked(order, courier, { bookWithCourier: false, attachCourierParcel: 'CX-7001' });

  const fresh = await Order.findById(order._id);
  assert.equal(fresh.status, 'dispatched');
  assert.equal(fresh.trackingId, 'CX-7001');
  assert.equal(fresh.courierBooking.trackingNumber, 'CX-7001');
  assert.equal(fresh.courierBooking.provider, 'postex');
});

test('a tracking number the courier does not know is refused, and the order does not move', async () => {
  fakePostex({ tracking: {} });
  const { order, courier } = await setupOrder();
  await assert.rejects(
    dispatchBooked(order, courier, { bookWithCourier: false, attachCourierParcel: 'CX-0000' }),
    /does not know that tracking number/
  );
  assert.equal((await Order.findById(order._id)).status, 'pending');
});

test('one parcel can not be attached to two orders', async () => {
  fakePostex({ tracking: { 'CX-7001': track('Unbooked') } });
  const first = await setupOrder();
  await dispatchBooked(first.order, first.courier, {
    bookWithCourier: false,
    attachCourierParcel: 'CX-7001'
  });
  const second = await setupOrder({ name: 'Other Shop' });
  await assert.rejects(
    dispatchBooked(second.order, second.courier, {
      bookWithCourier: false,
      attachCourierParcel: 'CX-7001'
    }),
    /already attached to another order/
  );
});

test('the load sheet is fetched with the booked parcels’ numbers, as a PDF', async () => {
  fakePostex({});
  const { order, courier, biz } = await setupOrder();
  await dispatchBooked(order, courier);

  let asked;
  courierDeps.fetchImpl = async (url, init) => {
    asked = { url: String(url), body: JSON.parse(init.body) };
    return new Response(Buffer.from('%PDF-1.4 sheet'), {
      status: 200,
      headers: { 'Content-Type': 'application/pdf' }
    });
  };
  const sent = {};
  await getLoadSheet(
    {
      user: admin,
      body: orderLoadSheetSchema.parse({
        business: String(biz._id),
        courier: String(courier._id),
        orderIds: [String(order._id)]
      })
    },
    {
      status() {
        return this;
      },
      set(h) {
        sent.headers = h;
        return this;
      },
      send(body) {
        sent.body = body;
      }
    },
    e => {
      throw e;
    }
  );
  await new Promise(r => setTimeout(r, 50));
  assert.match(asked.url, /generate-load-sheet$/);
  assert.deepEqual(asked.body.trackingNumbers, ['CX-1001']);
  assert.match(sent.body.toString(), /^%PDF/);
});
