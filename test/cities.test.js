import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, makeBusiness, oid, runHandler, userId } from './helpers/db.js';
import Order from '../models/Order.js';
import Customer from '../models/Customer.js';
import { PAKISTAN_CITIES, isListedCity, normalizeCity } from '../utils/cities.js';
import { getCities } from '../controllers/systemController.js';

/**
 * A courier report by city is only as good as the city names under it: "Lahore",
 * "lahore " and "LHR" must be one place, however they were typed.
 */

before(connect);
after(disconnect);
afterEach(clear);

test('a listed city or a known alias becomes the listed name, whatever the case or spacing', () => {
  assert.equal(normalizeCity(' lahore '), 'Lahore');
  assert.equal(normalizeCity('LHR'), 'Lahore');
  assert.equal(normalizeCity('khi'), 'Karachi');
  assert.equal(normalizeCity('D.G. Khan'), 'Dera Ghazi Khan');
  assert.equal(normalizeCity('rawal   pindi'), 'Rawalpindi');
  assert.equal(normalizeCity('Mingora'), 'Mingora (Swat)');
});

test('a listed name comes back unchanged', () => {
  for (const city of PAKISTAN_CITIES) assert.equal(normalizeCity(city), city);
});

test('an unknown place is tidied into Title Case, not guessed', () => {
  assert.equal(normalizeCity('new   town'), 'New Town');
  assert.equal(normalizeCity('SAMUNDRI'), 'Samundri');
});

test('empty and non-text input has no city', () => {
  assert.equal(normalizeCity(''), undefined);
  assert.equal(normalizeCity('   '), undefined);
  assert.equal(normalizeCity(undefined), undefined);
  assert.equal(normalizeCity(42), undefined);
});

test('isListedCity is true only for an exact listed name', () => {
  assert.equal(isListedCity('Lahore'), true);
  assert.equal(isListedCity('lahore'), false);
  assert.equal(isListedCity('Samundri'), false);
});

test('the city list has no duplicates and is alphabetical', () => {
  assert.equal(new Set(PAKISTAN_CITIES).size, PAKISTAN_CITIES.length);
  assert.deepEqual(
    [...PAKISTAN_CITIES].sort((a, b) => a.localeCompare(b)),
    PAKISTAN_CITIES
  );
});

test('GET /system/cities serves the list', async () => {
  const { status, body } = await runHandler(getCities);
  assert.equal(status, 200);
  assert.deepEqual(body.data, PAKISTAN_CITIES);
});

const orderOf = (business, city) => ({
  business,
  customer: oid(),
  customerName: 'Ali',
  contactNumber: '03001234567',
  city,
  items: [
    {
      product: oid(),
      variantId: oid(),
      productName: 'P',
      quantity: 1,
      unitPrice: 100,
      unitCost: 50
    }
  ],
  createdBy: userId
});

test('an order stores the canonical city, on create and when edited', async () => {
  const biz = await makeBusiness();
  const order = await Order.create(orderOf(biz._id, 'lhr'));
  assert.equal(order.city, 'Lahore');

  order.city = ' karachi ';
  await order.save();
  assert.equal((await Order.findById(order._id)).city, 'Karachi');
});

test('a city set through an update query is normalised too', async () => {
  const biz = await makeBusiness();
  const order = await Order.create(orderOf(biz._id, 'Lahore'));
  await Order.updateOne({ _id: order._id }, { $set: { city: 'isb' } });
  assert.equal((await Order.findById(order._id)).city, 'Islamabad');
});

test('a customer stores the canonical city, including through an update', async () => {
  const biz = await makeBusiness();
  const customer = await Customer.create({
    business: biz._id,
    name: 'Ali',
    phone: '03001234567',
    city: 'rwp',
    createdBy: userId
  });
  assert.equal(customer.city, 'Rawalpindi');

  await Customer.findOneAndUpdate({ _id: customer._id }, { $set: { city: 'fsd' } });
  assert.equal((await Customer.findById(customer._id)).city, 'Faisalabad');
});
