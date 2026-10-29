import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, runHandler, oid } from './helpers/db.js';
import Order from '../models/Order.js';
import Notification from '../models/Notification.js';
import { clearCityCache } from '../utils/couriers/booking.js';
import { cityMatchKey, nearCities } from '../utils/cities.js';
import { checkHeldCities } from '../utils/cityWatch.js';
import { previewParcel } from '../utils/couriers/booking.js';
import { updateOrder, bookWaitingOrders } from '../controllers/orderController.js';
import { searchCities } from '../controllers/cityController.js';
import { orderUpdateSchema } from '../schemas/orders.js';
import { admin, fakePostex, restoreFetch, setupOrder, dispatchBooked } from './helpers/courier.js';

/**
 * Cities and the courier (R9-7): the search box knows which cities PostEx serves, a booking carries the
 * courier's own spelling, a city it refuses holds the order, and the hourly check tells people once when
 * the city is listed again.
 */
before(connect);
after(disconnect);
afterEach(async () => {
  restoreFetch();
  clearCityCache();
  await clear();
});

test('places are the same whatever the spaces, hyphens or case', () => {
  assert.equal(cityMatchKey('Islam Kot'), cityMatchKey('islamkot'));
  assert.equal(cityMatchKey('Islam-Kot'), cityMatchKey('ISLAMKOT'));
  assert.notEqual(cityMatchKey('Sahiwal'), cityMatchKey('Sialkot'));
});

test('a near spelling is suggested from the courier list; nothing like it suggests nothing', () => {
  const list = ['Islamkot', 'Islamabad', 'Lahore', 'Karachi'];
  assert.deepEqual(nearCities(list, 'Islam Kot')[0], 'Islamkot');
  assert.ok(nearCities(list, 'Islamabd').includes('Islamabad'));
  assert.deepEqual(nearCities(list, 'Zzzzzz'), []);
  assert.deepEqual(nearCities(list, 'is'), [], 'two letters mean nothing');
});

test('a city PostEx lists but marks as not delivering is not served', async () => {
  fakePostex({
    cities: [
      'Lahore',
      { name: 'Sehwan', isDeliveryCity: 'false' },
      { name: 'Multan', isDeliveryCity: 'true' }
    ]
  });
  const { order, courier } = await setupOrder({ city: 'Sehwan' });
  await assert.rejects(dispatchBooked(order, courier), /does not deliver to Sehwan/);

  fakePostex({ cities: ['Lahore', { name: 'Multan', isDeliveryCity: 'true' }] });
  const ok = await setupOrder({ city: 'Multan' });
  await dispatchBooked(ok.order, ok.courier);
  assert.equal((await Order.findById(ok.order._id)).status, 'dispatched');
});

test('a booking carries the courier’s own spelling of the place', async () => {
  const { creates } = fakePostex({ cities: ['Lahore', 'Islamkot'] });
  const { order, courier } = await setupOrder({ city: 'Islam Kot' });
  await dispatchBooked(order, courier);
  assert.equal(creates[0].cityName, 'Islamkot');
});

test('a refused city says what was probably meant, and the order waits for it', async () => {
  fakePostex({ cities: ['Lahore', 'Karachi', 'Islamkot'] });
  const { order, courier } = await setupOrder({ city: 'Islamkott' });

  await assert.rejects(dispatchBooked(order, courier), err =>
    /does not deliver to Islamkott — did you mean Islamkot\?/.test(err.message)
  );
  const held = await Order.findById(order._id);
  assert.equal(held.status, 'pending', 'the order did not move');
  assert.equal(held.awaitingCity.city, 'Islamkott');
  assert.equal(String(held.awaitingCity.courier), String(courier._id));
  assert.equal(held.awaitingCity.openedAt, undefined);
});

test('the preview carries the near-miss to fix in one tap', async () => {
  fakePostex({ cities: ['Lahore', 'Islamkot'] });
  const { order, courier } = await setupOrder({ city: 'Islamkott' });
  const preview = await previewParcel(order, courier._id);
  assert.match(preview.problems.join(' '), /did you mean Islamkot/);
  assert.deepEqual(preview.citySuggestions, ['Islamkot']);
});

test('when the courier lists the city again the hourly check opens the order and tells people ONCE', async () => {
  fakePostex({ cities: ['Lahore'] });
  const one = await setupOrder({ city: 'Mirpur Khas' });
  await assert.rejects(dispatchBooked(one.order, one.courier));

  assert.deepEqual(
    await checkHeldCities(),
    { checked: 1, opened: 0 },
    'still closed: nothing happens'
  );
  assert.equal(await Notification.countDocuments({ type: 'courier-city-open' }), 0);

  fakePostex({ cities: ['Lahore', 'Mirpur Khas'] });
  clearCityCache(); // the real check reads the list fresh; the cache of an earlier hour must not hide it
  assert.deepEqual(await checkHeldCities(), { checked: 1, opened: 1 });
  const note = await Notification.findOne({ type: 'courier-city-open' });
  assert.match(note.title, /Mirpur Khas is open again — 1 order can be booked/);
  assert.ok((await Order.findById(one.order._id)).awaitingCity.openedAt);

  assert.deepEqual(await checkHeldCities(), { checked: 0, opened: 0 }, 'already announced');
  assert.equal(await Notification.countDocuments({ type: 'courier-city-open' }), 1);
});

test('Book all books the opened orders through the normal dispatch path and clears the hold', async () => {
  fakePostex({ cities: ['Lahore'] });
  const { order, courier, biz } = await setupOrder({ city: 'Sehwan' });
  await assert.rejects(dispatchBooked(order, courier));

  fakePostex({ cities: ['Lahore', 'Sehwan'] });
  clearCityCache();
  await checkHeldCities();

  const { body } = await runHandler(bookWaitingOrders, {
    user: admin,
    body: { business: String(biz._id), orderIds: [String(order._id), String(oid())] }
  });
  assert.equal(body.data.booked, 1);
  assert.equal(
    body.data.results[1].ok,
    false,
    'an order that is not waiting is reported, not booked'
  );

  const booked = await Order.findById(order._id);
  assert.equal(booked.status, 'dispatched');
  assert.ok(booked.courierBooking.trackingNumber);
  assert.equal(booked.awaitingCity, undefined, 'nothing is waiting any more');
});

test('Book all refuses an order whose city has not opened yet', async () => {
  fakePostex({ cities: ['Lahore'] });
  const { order, courier, biz } = await setupOrder({ city: 'Sehwan' });
  await assert.rejects(dispatchBooked(order, courier));

  const { body } = await runHandler(bookWaitingOrders, {
    user: admin,
    body: { business: String(biz._id), orderIds: [String(order._id)] }
  });
  assert.equal(body.data.booked, 0);
  assert.equal((await Order.findById(order._id)).status, 'pending');
});

test('changing the order’s city stops it waiting for the old one', async () => {
  fakePostex({ cities: ['Lahore'] });
  const { order, courier } = await setupOrder({ city: 'Sehwan' });
  await assert.rejects(dispatchBooked(order, courier));
  assert.ok((await Order.findById(order._id)).awaitingCity);

  const fresh = await Order.findById(order._id);
  await runHandler(updateOrder, {
    user: admin,
    resource: fresh,
    body: orderUpdateSchema.parse({
      customerName: fresh.customerName,
      contactNumber: fresh.contactNumber,
      city: 'Lahore',
      deliveryAddress: fresh.deliveryAddress,
      items: fresh.items.map(i => ({
        product: String(i.product),
        variantId: String(i.variantId),
        quantity: i.quantity,
        unitPrice: i.unitPrice
      }))
    })
  });
  assert.equal((await Order.findById(order._id)).awaitingCity, undefined);
});

const searchAs = (user, query) => runHandler(searchCities, { user, query }).then(r => r.body);

test('city search merges our list with the courier’s, the courier’s spelling wins, each marked served or not', async () => {
  fakePostex({ cities: ['Lahore', 'Islamkot'] });
  const { biz } = await setupOrder();
  const user = { ...admin, assignedBusinesses: [biz._id] };

  const { data, total } = await searchAs(user, { business: String(biz._id), search: 'isl' });
  const names = data.map(c => c.name);
  assert.ok(names.includes('Islamkot'), 'a courier city we did not list is offered');
  assert.ok(names.includes('Islamabad'), 'one of ours is too');
  assert.ok(total >= 2);

  const kot = data.find(c => c.name === 'Islamkot');
  const abad = data.find(c => c.name === 'Islamabad');
  assert.equal(kot.served.postex, true);
  assert.equal(abad.served.postex, false, 'ours, but PostEx does not list it');
});

test('city search matches anywhere in the name, ignores spaces, puts names that start with it first, five at a time', async () => {
  fakePostex({ cities: ['Lahore', 'Islamkot'] });
  const { biz } = await setupOrder();
  const user = { ...admin, assignedBusinesses: [biz._id] };

  const hit = await searchAs(user, { business: String(biz._id), search: 'Islam Kot' });
  assert.equal(hit.data[0].name, 'Islamkot');

  const first = await searchAs(user, { business: String(biz._id), search: 'a', limit: '5' });
  assert.equal(first.count, 5);
  assert.ok(first.total > 5);
  assert.deepEqual(first.pagination.next, { page: 2, limit: 5 });
  const startsWithA = first.data.map(c => cityMatchKey(c.name).startsWith('a'));
  const firstOther = startsWithA.indexOf(false);
  assert.ok(startsWithA[0], 'a name that starts with the typed text leads');
  assert.ok(
    firstOther === -1 || startsWithA.slice(firstOther).every(starts => !starts),
    'every name that starts with it comes before any that merely contains it'
  );
});

test('someone not in the business gets the plain list with no courier marks, not an error', async () => {
  fakePostex({ cities: ['Lahore', 'Islamkot'] });
  const { biz } = await setupOrder();
  const outsider = { id: oid(), role: { fullAccess: false }, assignedBusinesses: [oid()] };

  const { data } = await searchAs(outsider, { business: String(biz._id), search: 'lahore' });
  assert.equal(data[0].name, 'Lahore');
  assert.deepEqual(data[0].served, {}, 'which couriers serve it is only for your own business');
  const kot = await searchAs(outsider, { business: String(biz._id), search: 'islamkot' });
  assert.equal(kot.count, 0, 'the courier’s own list is not leaked either');
});

test('a courier that can not be asked shows no tick and never blocks the list', async () => {
  fakePostex({ cities: ['Lahore'] });
  const { biz } = await setupOrder();
  clearCityCache();
  const failing = async () => new Response('boom', { status: 500 });
  const { courierDeps } = await import('../utils/couriers/index.js');
  courierDeps.fetchImpl = failing;

  const user = { ...admin, assignedBusinesses: [biz._id] };
  const { data } = await searchAs(user, { business: String(biz._id), search: 'lahore' });
  assert.equal(data[0].name, 'Lahore');
  assert.deepEqual(data[0].served, {});
});
