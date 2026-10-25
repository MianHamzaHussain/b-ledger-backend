import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, runHandler } from './helpers/db.js';
import Order from '../models/Order.js';
import Product from '../models/Product.js';
import {
  cancelCourierParcel,
  confirmCourierStatus,
  getCourierReady
} from '../controllers/orderController.js';
import { orderCourierConfirmSchema } from '../schemas/orders.js';
import { clearCityCache } from '../utils/couriers/booking.js';
import { runCourierSync } from '../utils/courierSync.js';
import { orderSummary } from '../utils/orderSummary.js';
import { admin, fakePostex, restoreFetch, setupOrder, dispatchBooked } from './helpers/courier.js';

/**
 * One tap confirms what the courier reports. It goes through the SAME status path as the button, so
 * the books are exactly what a person would have made — and the courier's fee is filled in only when
 * the courier has reported one.
 */
before(connect);
after(disconnect);
afterEach(async () => {
  restoreFetch();
  clearCityCache();
  await clear();
});

const hist = (...codes) =>
  codes.map(([code, message]) => ({
    transactionStatusMessageCode: code,
    transactionStatusMessage: message
  }));

/** A booked, dispatched order the courier already reports as `record`, marked ready to confirm. */
const ready = async (record, opts) => {
  fakePostex({});
  const made = await setupOrder(opts);
  await dispatchBooked(made.order, made.courier);
  fakePostex({ tracking: { 'CX-1001': record } });
  await runCourierSync();
  return made;
};

const confirm = (made, ids) =>
  runHandler(confirmCourierStatus, {
    user: admin,
    body: orderCourierConfirmSchema.parse({
      business: String(made.biz._id),
      orderIds: (ids ?? [made.order._id]).map(String)
    })
  });

test('delivered: the order is delivered the normal way, with the courier’s fee, and the mark is cleared', async () => {
  const made = await ready({
    transactionStatus: 'Delivered',
    transactionFee: 180,
    transactionTax: 29,
    transactionStatusHistory: hist(['0005', 'Delivered'])
  });
  assert.equal((await orderSummary(made.biz._id)).courierReady, 1, 'the strip counts it');
  const out = await confirm(made);
  assert.equal(out.body.data.confirmed, 1);
  assert.equal((await orderSummary(made.biz._id)).courierReady, 0);

  const fresh = await Order.findById(made.order._id);
  assert.equal(fresh.status, 'delivered');
  assert.equal(fresh.deliveryChargePaisa, 20900, 'fee + tax, in paisa');
  assert.ok(fresh.saleEntry, 'the sale was posted exactly as the button would');
  assert.equal(fresh.courierBooking.confirmable, undefined);
  assert.equal(fresh.statusHistory.at(-1).note, 'Confirmed from the courier’s status');
});

test('the confirm list names each parcel with the fee that will be filled in', async () => {
  const made = await ready({
    transactionStatus: 'Delivered',
    transactionFee: 100,
    transactionTax: 16,
    transactionStatusHistory: hist(['0005', 'Delivered'])
  });
  const out = await runHandler(getCourierReady, {
    user: admin,
    accessFilter: {},
    query: { business: String(made.biz._id) }
  });
  assert.equal(out.body.data.length, 1);
  assert.equal(out.body.data[0].kind, 'delivered');
  assert.equal(out.body.data[0].fee, 116);
  assert.equal(out.body.data[0].trackingId, 'CX-1001');
});

test('returned: the order is returned, the stock goes back, the return fee is filled in', async () => {
  const made = await ready({
    transactionStatus: 'Returned',
    reversalFee: 120,
    reversalTax: 19,
    transactionStatusHistory: hist(['0006', 'Returned'])
  });
  const before = (await Product.findById(made.order.items[0].product)).variants[0].stock;
  await confirm(made);

  const fresh = await Order.findById(made.order._id);
  assert.equal(fresh.status, 'returned');
  assert.equal(fresh.returnChargePaisa, 13900);
  const after = (await Product.findById(made.order.items[0].product)).variants[0].stock;
  assert.equal(after, before + 2, 'the two pieces are back on the shelf');
});

test('no fee reported yet: the charge is left open for the courier invoice, not booked as zero', async () => {
  const made = await ready({
    transactionStatus: 'Delivered',
    transactionStatusHistory: hist(['0005', 'Delivered'])
  });
  await confirm(made);
  const fresh = await Order.findById(made.order._id);
  assert.equal(fresh.status, 'delivered');
  assert.equal(fresh.deliveryChargePaisa, undefined);
});

test('an order the courier has not reported is refused, and the rest of the batch still goes through', async () => {
  const made = await ready({
    transactionStatus: 'Delivered',
    transactionFee: 100,
    transactionStatusHistory: hist(['0005', 'Delivered'])
  });
  const stranger = await Order.findById(made.order._id);
  const other = await setupOrder({ name: 'Other Shop' }); // a different business and never dispatched
  const out = await runHandler(confirmCourierStatus, {
    user: admin,
    body: orderCourierConfirmSchema.parse({
      business: String(made.biz._id),
      orderIds: [String(other.order._id), String(stranger._id)]
    })
  });
  assert.equal(out.body.data.confirmed, 1);
  assert.equal(out.body.data.results[0].ok, false);
  assert.match(out.body.data.results[0].reason, /has not reported/);
  assert.equal(out.body.data.results[1].ok, true);
});

test('confirming twice does not post anything twice', async () => {
  const made = await ready({
    transactionStatus: 'Delivered',
    transactionFee: 100,
    transactionStatusHistory: hist(['0005', 'Delivered'])
  });
  await confirm(made);
  const again = await confirm(made);
  assert.equal(again.body.data.confirmed, 0);
  assert.equal(await Order.countDocuments({ status: 'delivered' }), 1);
});

test('the batch is limited to 50 and needs at least one', () => {
  const ids = Array.from({ length: 51 }, (_, i) => `id${i}`);
  assert.equal(
    orderCourierConfirmSchema.safeParse({ business: 'b', orderIds: ids }).success,
    false
  );
  assert.equal(orderCourierConfirmSchema.safeParse({ business: 'b', orderIds: [] }).success, false);
});

test('cancelling at the courier returns the order with no charge and puts the stock back', async () => {
  fakePostex({});
  const made = await setupOrder();
  await dispatchBooked(made.order, made.courier);
  const { calls } = fakePostex({});
  const stockBefore = (await Product.findById(made.order.items[0].product)).variants[0].stock;

  await runHandler(cancelCourierParcel, {
    user: admin,
    resource: await Order.findById(made.order._id)
  });

  assert.ok(calls.some(u => u.includes('cancel-order')));
  const fresh = await Order.findById(made.order._id);
  assert.equal(fresh.status, 'returned');
  assert.equal(fresh.returnChargePaisa, 0);
  assert.equal(fresh.courierBooking.courierStatus, 'Cancelled');
  const stockAfter = (await Product.findById(made.order.items[0].product)).variants[0].stock;
  assert.equal(stockAfter, stockBefore + 2);
});

test('if the courier refuses to cancel (already picked up), the order stays dispatched', async () => {
  fakePostex({});
  const made = await setupOrder();
  await dispatchBooked(made.order, made.courier);
  fakePostex({ failCancel: 'Order already picked up' });

  await assert.rejects(
    runHandler(cancelCourierParcel, {
      user: admin,
      resource: await Order.findById(made.order._id)
    }),
    /already picked up/
  );
  assert.equal((await Order.findById(made.order._id)).status, 'dispatched');
});

test('only a dispatched, courier-booked parcel can be cancelled there', async () => {
  const made = await setupOrder();
  await assert.rejects(
    runHandler(cancelCourierParcel, { user: admin, resource: made.order }),
    /dispatched parcel booked through a courier/
  );
});
