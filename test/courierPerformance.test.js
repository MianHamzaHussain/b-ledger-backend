import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  connect,
  clear,
  disconnect,
  makeBusiness,
  makeProduct,
  makeParty,
  runHandler,
  oid,
  userId
} from './helpers/db.js';
import Order from '../models/Order.js';
import Party from '../models/Party.js';
import { getCourierPerformance } from '../controllers/financeController.js';
import { MIN_DECIDED } from '../utils/courierPerformance.js';

/**
 * The courier report. The rules worth pinning: refunded and exchanged parcels
 * were DELIVERED (the customer sent them back afterwards) and never count
 * against a courier; a cancelled order has no courier, so it is one number for
 * the period; ratios use only the parcels the courier finished; ranges are
 * Pakistan days.
 */

before(connect);
after(disconnect);
afterEach(clear);

/** A moment in Pakistan time, e.g. at('2026-10-05', '14:30'). */
const at = (day, time = '12:00') => new Date(`${day}T${time}:00+05:00`);
const DAYS = n => n * 24 * 60 * 60 * 1000;

async function setup() {
  const biz = await makeBusiness();
  const product = await makeProduct(biz._id);
  const tcs = await makeParty(biz._id, 'courier', { name: 'TCS' });
  const postex = await makeParty(biz._id, 'courier', { name: 'PostEx' });
  return { biz, product, tcs, postex };
}

/**
 * One parcel with exact dates. `Order.create` stamps the dates "now", so they are
 * overwritten underneath it — the report reads what is stored.
 */
async function parcel(ctx, o) {
  const {
    courier,
    city = 'Lahore',
    status = 'dispatched',
    sent = at('2026-10-05'),
    days,
    tracked = false,
    attempts = 0,
    business = ctx.biz
  } = o;
  const order = await Order.create({
    business: business._id,
    customer: oid(),
    customerName: 'Ali',
    contactNumber: '03001234567',
    city,
    courier: courier?._id,
    status,
    items: [
      {
        product: ctx.product._id,
        variantId: ctx.product.variants[0]._id,
        productName: 'P',
        quantity: 1,
        unitPrice: 2000,
        unitCost: 1000
      }
    ],
    createdBy: userId
  });
  const set = { dispatchedAt: sent, attemptsTracked: tracked };
  if (o.city === null)
    await Order.collection.updateOne({ _id: order._id }, { $unset: { city: '' } });
  if (days !== undefined) set.deliveredAt = new Date(sent.getTime() + DAYS(days));
  if (attempts) {
    set.deliveryAttempts = Array.from({ length: attempts }, () => ({
      reason: 'not-available',
      at: sent
    }));
  }
  await Order.collection.updateOne({ _id: order._id }, { $set: set });
  return order;
}

const report = (ctx, query = {}, extra = {}) =>
  runHandler(getCourierPerformance, {
    query: {
      business: String(ctx.biz._id),
      from: '2026-10-01',
      to: '2026-10-31',
      by: 'courier',
      ...query
    },
    ...extra
  }).then(r => r.body.data);

const row = (data, courier, city) =>
  data.rows.find(r => (courier ? r.courier === courier : true) && (city ? r.city === city : true));

/** TCS and PostEx over a month, covering every outcome. */
async function monthOfParcels(ctx) {
  const { tcs, postex } = ctx;
  // TCS · Lahore: 3 delivered on the first try or after one failed attempt (tracked)
  await parcel(ctx, { courier: tcs, status: 'delivered', days: 2, tracked: true });
  await parcel(ctx, { courier: tcs, status: 'delivered', days: 3, tracked: true });
  await parcel(ctx, { courier: tcs, status: 'delivered', days: 4, tracked: true, attempts: 1 });
  await parcel(ctx, { courier: tcs, status: 'returned' });
  await parcel(ctx, { courier: tcs, status: 'dispatched' });
  // …delivered, then the customer sent them back: still DELIVERED by the courier
  await parcel(ctx, { courier: tcs, status: 'refunded', days: 2 });
  await parcel(ctx, { courier: tcs, status: 'exchanged', days: 4 });
  // TCS · Karachi, sent before attempts could be logged
  await parcel(ctx, { courier: tcs, city: 'Karachi', status: 'delivered', days: 1 });
  // PostEx · Lahore
  await parcel(ctx, { courier: postex, status: 'delivered', days: 2 });
  await parcel(ctx, { courier: postex, status: 'delivered', days: 2 });
  await parcel(ctx, { courier: postex, status: 'returned' });
  await parcel(ctx, { courier: postex, status: 'returned' });
  // A cancelled order never has a courier; one in range, one out of range
  const cancelled = await parcel(ctx, { status: 'pending', courier: undefined });
  await Order.collection.updateOne(
    { _id: cancelled._id },
    { $set: { status: 'cancelled', cancelledAt: at('2026-10-10') }, $unset: { dispatchedAt: '' } }
  );
  const old = await parcel(ctx, { status: 'pending', courier: undefined });
  await Order.collection.updateOne(
    { _id: old._id },
    { $set: { status: 'cancelled', cancelledAt: at('2026-09-10') }, $unset: { dispatchedAt: '' } }
  );
  // A counter sale has no courier and is never counted
  await parcel(ctx, { courier: undefined, status: 'delivered', days: 0 });
}

test('counts every outcome per courier; refunded and exchanged count as delivered AND show apart', async () => {
  const ctx = await setup();
  await monthOfParcels(ctx);
  const data = await report(ctx);

  const tcs = row(data, 'TCS');
  assert.equal(tcs.dispatched, 8);
  assert.equal(tcs.delivered, 6, '3 + refunded + exchanged + Karachi');
  assert.equal(tcs.refunded, 1);
  assert.equal(tcs.exchanged, 1);
  assert.equal(tcs.returned, 1);
  assert.equal(tcs.inTransit, 1);
  assert.equal(tcs.delivered + tcs.returned + tcs.inTransit, tcs.dispatched);
});

test('ratios use the parcels the courier finished — refunds never count against it', async () => {
  const ctx = await setup();
  await monthOfParcels(ctx);
  const tcs = row(await report(ctx), 'TCS');

  assert.equal(tcs.decided, 7, 'delivered 6 + returned 1');
  assert.equal(tcs.deliveredPct, 85.7);
  assert.equal(tcs.returnedPct, 14.3);
  assert.equal(tcs.sentBackByCustomerPct, 33.3, '(1 refunded + 1 exchanged) of 6 delivered');
});

test('adding a refund changes the sent-back figure but not delivered % or returned %', async () => {
  const ctx = await setup();
  await parcel(ctx, { courier: ctx.tcs, status: 'delivered', days: 2 });
  await parcel(ctx, { courier: ctx.tcs, status: 'returned' });
  const before = row(await report(ctx), 'TCS');

  await parcel(ctx, { courier: ctx.tcs, status: 'delivered', days: 2 });
  await parcel(ctx, { courier: ctx.tcs, status: 'refunded', days: 2 });
  const after = row(await report(ctx), 'TCS');

  assert.equal(before.sentBackByCustomerPct, 0);
  assert.ok(after.sentBackByCustomerPct > 0);
  assert.equal(after.returned, before.returned);
  assert.equal(after.returnedPct, 25, '1 returned of 4 finished (3 delivered + 1 returned)');
});

test('average days to deliver, weighted over delivered parcels (refunded and exchanged included)', async () => {
  const ctx = await setup();
  await monthOfParcels(ctx);
  const tcs = row(await report(ctx), 'TCS');
  // days: 2 + 3 + 4 + 2 (refunded) + 4 (exchanged) + 1 (Karachi) = 16, over 6 parcels
  assert.equal(tcs.avgDaysToDeliver, 2.7);
});

test('first-attempt % counts only parcels whose attempts were tracked', async () => {
  const ctx = await setup();
  await monthOfParcels(ctx);
  const data = await report(ctx);

  const tcs = row(data, 'TCS');
  assert.equal(tcs.firstAttemptBasis, 3, 'three tracked deliveries');
  assert.equal(tcs.firstAttemptPct, 66.7, '2 of the 3 had no failed attempt');

  const postex = row(data, 'PostEx');
  assert.equal(postex.firstAttemptBasis, 0);
  assert.equal(postex.firstAttemptPct, null, 'nothing tracked → no figure, not 0%');
});

test('a cancelled order is in no row and no ratio, only the period total', async () => {
  const ctx = await setup();
  await monthOfParcels(ctx);

  for (const by of ['courier', 'city', 'courier-city']) {
    const data = await report(ctx, { by });
    assert.equal(data.cancelledBeforeDispatch, 1, `${by}: only the one cancelled in range`);
    const sent = data.rows.reduce((n, r) => n + r.dispatched, 0);
    assert.equal(sent, 12, `${by}: 8 TCS + 4 PostEx, nothing else`);
    assert.equal(data.totals.dispatched, 12);
  }
});

test('a counter sale and another business’s parcels never appear', async () => {
  const ctx = await setup();
  await monthOfParcels(ctx);
  const other = await makeBusiness({ name: 'Other Biz' });
  const theirCourier = await makeParty(other._id, 'courier', { name: 'TCS' });
  await parcel(ctx, { business: other, courier: theirCourier, status: 'delivered', days: 1 });

  const data = await report(ctx);
  assert.equal(data.totals.dispatched, 12);
  assert.equal(data.rows.length, 2, 'TCS and PostEx of this business only');
});

test('grouping by city and by courier + city', async () => {
  const ctx = await setup();
  await monthOfParcels(ctx);

  const byCity = await report(ctx, { by: 'city' });
  assert.equal(byCity.rows.length, 2);
  const lahore = row(byCity, null, 'Lahore');
  assert.equal(lahore.dispatched, 11);
  assert.equal(lahore.courier, undefined, 'no courier key when grouped by city');
  assert.equal(row(byCity, null, 'Karachi').dispatched, 1);

  const both = await report(ctx, { by: 'courier-city' });
  assert.equal(both.rows.length, 3);
  const tcsLahore = row(both, 'TCS', 'Lahore');
  assert.equal(tcsLahore.dispatched, 7);
  assert.equal(row(both, 'PostEx', 'Lahore').returned, 2);
});

test('rows are sorted by delivered, most first', async () => {
  const ctx = await setup();
  await monthOfParcels(ctx);
  const data = await report(ctx);
  assert.deepEqual(
    data.rows.map(r => r.courier),
    ['TCS', 'PostEx']
  );
});

test('an order with no city is grouped as Unknown', async () => {
  const ctx = await setup();
  await parcel(ctx, { courier: ctx.tcs, city: null, status: 'delivered', days: 1 });
  const data = await report(ctx, { by: 'city' });
  assert.equal(data.rows[0].city, 'Unknown');
});

test('a courier shows its current name', async () => {
  const ctx = await setup();
  await parcel(ctx, { courier: ctx.tcs, status: 'delivered', days: 1 });
  await Party.updateOne({ _id: ctx.tcs._id }, { $set: { name: 'TCS Express' } });
  assert.equal((await report(ctx)).rows[0].courier, 'TCS Express');
});

test('too few to judge flips at MIN_DECIDED finished parcels', async () => {
  const ctx = await setup();
  for (let i = 0; i < MIN_DECIDED - 1; i++) {
    await parcel(ctx, { courier: ctx.tcs, status: 'delivered', days: 1 });
  }
  assert.equal(row(await report(ctx), 'TCS').tooFew, true, '9 decided');

  await parcel(ctx, { courier: ctx.tcs, status: 'returned' });
  assert.equal(row(await report(ctx), 'TCS').tooFew, false, '10 decided');
});

test('the date range uses Pakistan days, both edges', async () => {
  const ctx = await setup();
  const { tcs } = ctx;
  await parcel(ctx, { courier: tcs, status: 'dispatched', sent: at('2026-09-30', '23:59') });
  await parcel(ctx, { courier: tcs, status: 'dispatched', sent: at('2026-10-01', '00:01') });
  await parcel(ctx, { courier: tcs, status: 'dispatched', sent: at('2026-10-31', '23:30') });
  await parcel(ctx, { courier: tcs, status: 'dispatched', sent: at('2026-11-01', '00:30') });

  const data = await report(ctx);
  assert.equal(data.totals.dispatched, 2, 'the 1st at 00:01 and the 31st at 23:30');
});

test('an empty period returns zeros and no NaN', async () => {
  const ctx = await setup();
  const data = await report(ctx);
  assert.deepEqual(data.rows, []);
  assert.equal(data.totals.dispatched, 0);
  assert.equal(data.totals.deliveredPct, null);
  assert.equal(data.totals.avgDaysToDeliver, null);
  assert.equal(data.cancelledBeforeDispatch, 0);
});

test('a user outside the business is refused', async () => {
  const ctx = await setup();
  await assert.rejects(
    report(ctx, {}, { accessFilter: { business: { $in: [oid()] } } }),
    /not assigned/
  );
});

test('bad dates, an unknown grouping, or too long a range are refused', async () => {
  const ctx = await setup();
  await assert.rejects(report(ctx, { from: undefined }), /dates/);
  await assert.rejects(report(ctx, { to: 'tomorrow' }), /dates/);
  await assert.rejects(report(ctx, { from: '2026-10-31', to: '2026-10-01' }), /before the start/);
  await assert.rejects(report(ctx, { by: 'weather' }), /Group by/);
  await assert.rejects(report(ctx, { from: '2025-01-01', to: '2026-10-01' }), /year or less/);
  await assert.rejects(runHandler(getCourierPerformance, { query: {} }), /Select a business/);
});
