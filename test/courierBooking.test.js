import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, userId } from './helpers/db.js';
import Order from '../models/Order.js';
import { getAirwayBill } from '../controllers/orderController.js';
import { courierDeps } from '../utils/couriers/index.js';
import { bookParcel, clearCityCache } from '../utils/couriers/booking.js';
import {
  fakePostex,
  restoreFetch,
  setupOrder as setup,
  dispatchBooked as dispatch,
  KEY
} from './helpers/courier.js';

/**
 * Dispatching with "book with the courier": the parcel is made at PostEx, the tracking number comes
 * back by itself, and if PostEx says no the order does not move. A double tap never makes a second
 * parcel. (PostEx is a fake here — nothing in this suite can book a real parcel.)
 */
before(connect);
after(disconnect);
afterEach(async () => {
  restoreFetch();
  clearCityCache();
  await clear();
});

test('dispatching books the parcel itself: the tracking number comes back and the order moves', async () => {
  const { creates } = fakePostex();
  const { order, courier } = await setup();
  await dispatch(order, courier);

  const fresh = await Order.findById(order._id);
  assert.equal(fresh.status, 'dispatched');
  assert.equal(fresh.trackingId, 'CX-1001');
  assert.equal(fresh.courierBooking.trackingNumber, 'CX-1001');
  assert.equal(fresh.courierBooking.provider, 'postex');
  assert.equal(fresh.courierBooking.lockedAt, undefined);
  assert.equal(creates.length, 1);
});

test('the parcel carries what PostEx asks for, built from the order', async () => {
  const { creates } = fakePostex();
  const { order, courier } = await setup({ phone: '+92 300 1234567' });
  await dispatch(order, courier);
  const sent = creates[0];
  assert.equal(sent.customerPhone, '03001234567');
  assert.equal(sent.cityName, 'Lahore');
  assert.equal(sent.deliveryAddress, 'House 5, Gulberg');
  assert.equal(sent.invoicePayment, 4000);
  assert.equal(sent.items, 2);
  assert.equal(sent.pickupAddressCode, '001');
  assert.equal(sent.orderType, 'Normal');
  assert.equal(sent.orderRefNumber, String(order.orderNumber));
  assert.equal(sent.transactionNotes, 'Gift pack');
  assert.match(sent.orderDetail, /Test Product/);
});

test('a city PostEx does not serve stops the booking, and the order does not move', async () => {
  const { creates } = fakePostex({ cities: ['Karachi'] });
  const { order, courier } = await setup({ city: 'Lahore' });
  await assert.rejects(dispatch(order, courier), /does not deliver to Lahore/);
  assert.equal((await Order.findById(order._id)).status, 'pending');
  assert.equal(creates.length, 0);
});

test('PostEx refusing the parcel leaves the order as it was, and says why', async () => {
  fakePostex({ failCreate: 'Invalid delivery address' });
  const { order, courier } = await setup();
  await assert.rejects(dispatch(order, courier), /PostEx says: Invalid delivery address/);
  const fresh = await Order.findById(order._id);
  assert.equal(fresh.status, 'pending');
  assert.equal(
    fresh.courierBooking?.lockedAt,
    undefined,
    'a failed try does not block the next one'
  );
});

test('a landline instead of a mobile number is asked about before anything is sent', async () => {
  const { creates } = fakePostex();
  const { order, courier } = await setup({ phone: '042 111 222 333' });
  await assert.rejects(dispatch(order, courier), /mobile number/);
  assert.equal(creates.length, 0);
});

test('a missing delivery address is asked for before anything is sent', async () => {
  const { creates } = fakePostex();
  const { order, courier } = await setup({ address: '' });
  await assert.rejects(dispatch(order, courier), /delivery address/);
  assert.equal(creates.length, 0);
});

test('booking twice makes one parcel: the second finds the first', async () => {
  const { creates } = fakePostex();
  const { order, courier } = await setup();
  const first = await bookParcel(order, courier._id);
  const second = await bookParcel(await Order.findById(order._id), courier._id);
  assert.equal(first.already, false);
  assert.equal(second.already, true);
  assert.equal(second.trackingNumber, first.trackingNumber);
  assert.equal(creates.length, 1);
});

test('two taps at the same moment still make one parcel', async () => {
  const { creates } = fakePostex();
  const { order, courier } = await setup();
  const results = await Promise.allSettled([
    bookParcel(await Order.findById(order._id), courier._id),
    bookParcel(await Order.findById(order._id), courier._id)
  ]);
  assert.equal(creates.length, 1);
  const done = results.filter(r => r.status === 'fulfilled').map(r => r.value.trackingNumber);
  assert.ok(
    done.length >= 1 && new Set(done).size === 1,
    'everyone who got an answer got the same parcel'
  );
  for (const r of results.filter(r => r.status === 'rejected')) {
    assert.match(r.reason.message, /being booked right now/);
  }
});

test('a courier that is not connected can not be booked, and says so', async () => {
  fakePostex();
  const { order, courier } = await setup({ connected: false });
  await assert.rejects(dispatch(order, courier), /not connected/);
  assert.equal((await Order.findById(order._id)).status, 'pending');
});

test('without "book with courier" dispatch still works by typing a tracking number', async () => {
  const { creates } = fakePostex();
  const { order, courier } = await setup();
  await dispatch(order, courier, { bookWithCourier: false, trackingId: 'TCS-77' });
  assert.equal((await Order.findById(order._id)).trackingId, 'TCS-77');
  assert.equal(creates.length, 0);
});

test('the airway bill is fetched by the server with the saved key, as a PDF', async () => {
  fakePostex();
  const { order, courier } = await setup();
  await dispatch(order, courier);

  let asked;
  courierDeps.fetchImpl = async (url, init) => {
    asked = { url: String(url), token: init.headers.token };
    return new Response(Buffer.from('%PDF-1.4 bill'), {
      status: 200,
      headers: { 'Content-Type': 'application/pdf' }
    });
  };
  const sent = {};
  await getAirwayBill(
    // The signed-in person: printing a bill stamps who printed it.
    { resource: await Order.findById(order._id), user: { id: userId } },
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
  assert.match(sent.body.toString(), /^%PDF/);
  assert.equal(sent.headers['Content-Type'], 'application/pdf');
  assert.match(asked.url, /get-invoice\?trackingNumbers=CX-1001$/);
  assert.equal(asked.token, KEY);
});

test('an order that was not booked through a courier has no airway bill', async () => {
  const { order } = await setup();
  let error;
  await getAirwayBill({ resource: order }, {}, e => (error = e));
  await new Promise(r => setTimeout(r, 20));
  assert.match(error.message, /not booked through a courier/);
});
