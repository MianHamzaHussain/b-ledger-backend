import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, runHandler } from './helpers/db.js';
import Order from '../models/Order.js';
import Product from '../models/Product.js';
import { updateProduct } from '../controllers/productController.js';
import { getParcelPreview, updateOrderStatus } from '../controllers/orderController.js';
import { orderStatusSchema } from '../schemas/orders.js';
import { clearCityCache } from '../utils/couriers/booking.js';
import { productProfitability } from '../utils/reports.js';
import { admin, fakePostex, restoreFetch, setupOrder, dispatchBooked } from './helpers/courier.js';

/**
 * What the courier's slip says is what the order says NOW: a renamed article is renamed on the slip, the
 * customer's requests reach the Remarks box (and the shop's own note never does), and the dispatcher can
 * see all of it before booking.
 */
before(connect);
after(disconnect);
afterEach(async () => {
  restoreFetch();
  clearCityCache();
  await clear();
});

const rename = async (productId, name) =>
  runHandler(updateProduct, {
    user: admin,
    resource: await Product.findById(productId),
    body: { name }
  });

test('an article renamed after the order was taken goes on the slip, and on the order, by its new name', async () => {
  const { creates } = fakePostex();
  const { order, courier } = await setupOrder();
  assert.match(order.items[0].productName, /Test Product/);

  // Renamed directly, as if the order had been saved before the rename and never edited since.
  await Product.updateOne({ _id: order.items[0].product }, { name: 'Garden of Grace' });
  await dispatchBooked(order, courier);

  assert.match(creates[0].orderDetail, /^Garden of Grace/);
  assert.doesNotMatch(creates[0].orderDetail, /Test Product/);
  const fresh = await Order.findById(order._id);
  assert.equal(
    fresh.items[0].productName,
    'Garden of Grace',
    'the order carries the name the slip shows'
  );
  assert.equal(fresh.courierBooking.sentContents, creates[0].orderDetail);
});

test('renaming a product renames it on orders that have not shipped, and only those', async () => {
  fakePostex();
  const open = await setupOrder();
  const productId = open.order.items[0].product;
  const shipped = await setupOrder({ name: 'Second Customer' });
  // The second order belongs to a different business; put a shipped order on the first product instead.
  await Order.updateOne(
    { _id: shipped.order._id },
    { 'items.0.product': productId, status: 'dispatched' }
  );
  const delivered = await setupOrder({ name: 'Third Customer' });
  await Order.updateOne(
    { _id: delivered.order._id },
    { 'items.0.product': productId, status: 'delivered' }
  );

  await rename(productId, 'Garden of Grace');

  assert.equal((await Order.findById(open.order._id)).items[0].productName, 'Garden of Grace');
  assert.match((await Order.findById(shipped.order._id)).items[0].productName, /Test Product/);
  assert.match((await Order.findById(delivered.order._id)).items[0].productName, /Test Product/);
});

test('saving a product without renaming it touches no order', async () => {
  const { order } = await setupOrder();
  const before = await Order.findById(order._id);
  await runHandler(updateProduct, {
    user: admin,
    resource: await Product.findById(order.items[0].product),
    body: { lowStockThreshold: 3 }
  });
  assert.equal(String((await Order.findById(order._id)).updatedAt), String(before.updatedAt));
});

test('the customer’s note is the default Remarks, a typed message replaces it, the shop’s own note never goes', async () => {
  const { creates } = fakePostex();
  const first = await setupOrder();
  await Order.updateOne(
    { _id: first.order._id },
    { customerNote: 'Open parcel allowed', note: 'INTERNAL: loyal buyer' }
  );
  await dispatchBooked(await Order.findById(first.order._id), first.courier);
  assert.equal(creates[0].transactionNotes, 'Open parcel allowed');
  assert.doesNotMatch(JSON.stringify(creates[0]), /INTERNAL/);

  const second = await setupOrder({ name: 'Other' });
  await dispatchBooked(second.order, second.courier, {
    courierRemarks: 'COD — mention amount, transparent flyer'
  });
  assert.equal(creates[1].transactionNotes, 'COD — mention amount, transparent flyer');
  assert.equal(
    (await Order.findById(second.order._id)).courierBooking.remarks,
    'COD — mention amount, transparent flyer',
    'the order remembers what the slip was given'
  );
});

test('a courier message longer than the slip can print is refused', () => {
  const parsed = orderStatusSchema.safeParse({
    status: 'dispatched',
    courier: 'c',
    bookWithCourier: true,
    courierRemarks: 'x'.repeat(251)
  });
  assert.equal(parsed.success, false);
});

test('the preview shows exactly what booking sends, and sends nothing', async () => {
  const { creates, calls } = fakePostex();
  const { order, courier } = await setupOrder();
  await Order.updateOne({ _id: order._id }, { customerNote: 'Open parcel allowed' });
  const live = await Order.findById(order._id);

  const out = await runHandler(getParcelPreview, {
    user: admin,
    resource: live,
    query: { courier: String(courier._id) }
  });
  const shown = out.body.data;
  assert.equal(creates.length, 0, 'nothing was booked');
  assert.ok(!calls.some(u => u.includes('create-order')));
  assert.deepEqual(shown.problems, []);

  await dispatchBooked(live, courier);
  assert.equal(shown.contents, creates[0].orderDetail);
  assert.equal(shown.remarks, creates[0].transactionNotes);
  assert.equal(shown.phone, creates[0].customerPhone);
  assert.equal(shown.amount, creates[0].invoicePayment);
  assert.equal(shown.pieces, creates[0].items);
});

test('the preview names every problem at once, in plain words', async () => {
  fakePostex({ cities: ['Karachi'] });
  const { order, courier } = await setupOrder({ phone: '042 111 222 333', address: '' });
  const out = await runHandler(getParcelPreview, {
    user: admin,
    resource: await Order.findById(order._id),
    query: { courier: String(courier._id) }
  });
  assert.equal(out.body.data.problems.length, 2);
  assert.match(out.body.data.problems.join(' | '), /mobile number.*\|.*delivery address/);
});

test('the preview flags a city the courier does not serve', async () => {
  fakePostex({ cities: ['Karachi'] });
  const { order, courier } = await setupOrder({ city: 'Lahore' });
  const out = await runHandler(getParcelPreview, {
    user: admin,
    resource: await Order.findById(order._id),
    query: { courier: String(courier._id) }
  });
  assert.deepEqual(out.body.data.problems, ['PostEx does not deliver to Lahore']);
});

test('the profit report shows an article once, under its current name', async () => {
  fakePostex();
  const { order, courier, biz } = await setupOrder();
  await dispatchBooked(order, courier);
  await runHandler(updateOrderStatus, {
    user: admin,
    resource: await Order.findById(order._id),
    body: orderStatusSchema.parse({ status: 'delivered', deliveryCharge: 0 })
  });
  await Product.updateOne({ _id: order.items[0].product }, { name: 'Garden of Grace' });

  const rows = await productProfitability(biz._id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Garden of Grace');
});
