import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import {
  connect,
  clear,
  disconnect,
  makeBusiness,
  makeProduct,
  oid,
  userId
} from './helpers/db.js';
import Order from '../models/Order.js';
import { courierDeps } from '../utils/couriers/index.js';
import { airwayBillsFor, mergePdfs } from '../utils/airwayBills.js';
import { printAirwayBills, getAirwayBill } from '../controllers/orderController.js';
import { orderAirwayBillsSchema } from '../schemas/orders.js';
import { admin, restoreFetch, setupOrder, fakePostex, dispatchBooked } from './helpers/courier.js';

/**
 * Many airway bills as one PDF (R9-10): asked 10 at a time, stitched in the order ticked, one bad parcel
 * never blocks the rest, and nothing outside the business is ever fetched.
 */
before(connect);
after(disconnect);
afterEach(async () => {
  restoreFetch();
  await clear();
});

/** A PDF whose pages are 100 + n wide, so a test can read back which bills it holds and in what order. */
const bill = async numbers => {
  const doc = await PDFDocument.create();
  for (const n of numbers) doc.addPage([100 + n, 200]);
  return Buffer.from(await doc.save());
};
const widthsOf = async pdf => (await PDFDocument.load(pdf)).getPages().map(p => p.getWidth() - 100);

/** The tracking numbers asked for in a call to the courier's invoice endpoint ("T-007,T-008" → [7, 8]). */
const askedFor = url =>
  new URL(url).searchParams
    .get('trackingNumbers')
    .split(',')
    .map(t => Number(t.split('-')[1]));

/**
 * A fake courier that gives one page per parcel. `badNumber` makes any call that includes that parcel
 * fail; `calls` records every call so a test can count them.
 */
const fakeBills = ({ badNumber } = {}) => {
  const calls = [];
  courierDeps.fetchImpl = async url => {
    const numbers = askedFor(url);
    calls.push(numbers);
    if (badNumber && numbers.includes(badNumber)) {
      return new Response(JSON.stringify({ statusCode: '400', statusMessage: 'No bill' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(await bill(numbers), {
      status: 200,
      headers: { 'Content-Type': 'application/pdf' }
    });
  };
  return calls;
};

/** `count` dispatched parcels T-001… on the business's connected courier, made straight in the database. */
const parcels = async (ctx, count, from = 1) => {
  const product = await makeProduct(ctx.biz._id);
  const made = [];
  for (let i = from; i < from + count; i += 1) {
    made.push(
      await Order.create({
        business: ctx.biz._id,
        customer: oid(),
        customerName: `Buyer ${i}`,
        contactNumber: '03001234567',
        deliveryAddress: 'House 1',
        city: 'Lahore',
        courier: ctx.courier._id,
        status: 'dispatched',
        courierBooking: { provider: 'postex', trackingNumber: `T-${String(i).padStart(3, '0')}` },
        items: [
          {
            product: product._id,
            variantId: product.variants[0]._id,
            productName: product.name,
            quantity: 1,
            unitPrice: 2000,
            unitCost: 1000
          }
        ],
        codAmount: 2000,
        createdBy: userId
      })
    );
  }
  return made;
};

const ids = orders => orders.map(o => String(o._id));

test('stitching keeps every page of every bill, in order', async () => {
  const merged = await mergePdfs([await bill([1]), await bill([2, 3]), await bill([4])]);
  assert.deepEqual(await widthsOf(merged), [1, 2, 3, 4]);
});

test('25 bills are three calls of at most 10, and come back in the order they were ticked', async () => {
  fakePostex();
  const ctx = await setupOrder();
  const made = await parcels(ctx, 25);
  const calls = fakeBills();

  const ticked = [...made].reverse(); // the person ticked them last-first
  const { pdf, printed, skipped } = await airwayBillsFor({
    business: ctx.biz._id,
    orderIds: ids(ticked)
  });

  assert.equal(calls.length, 3);
  assert.ok(calls.every(c => c.length <= 10));
  assert.deepEqual(skipped, []);
  assert.equal(printed.length, 25);
  assert.deepEqual(
    await widthsOf(pdf),
    Array.from({ length: 25 }, (_, i) => 25 - i),
    'tick order kept'
  );
});

test('a call the courier rejects is retried parcel by parcel; one bad parcel does not block the rest', async () => {
  fakePostex();
  const ctx = await setupOrder();
  const made = await parcels(ctx, 12);
  const calls = fakeBills({ badNumber: 5 });

  const { pdf, printed, skipped } = await airwayBillsFor({
    business: ctx.biz._id,
    orderIds: ids(made)
  });

  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].orderNumber, made[4].orderNumber);
  assert.equal(printed.length, 11);
  const pages = await widthsOf(pdf);
  assert.ok(!pages.includes(5), 'the bad parcel has no page');
  assert.ok(pages.includes(4) && pages.includes(6) && pages.includes(12), 'its neighbours do');
  assert.ok(
    calls.some(c => c.length === 1),
    'it fell back to single calls'
  );
});

test('an order that was never booked through a courier is named, and the rest print', async () => {
  fakePostex();
  const ctx = await setupOrder(); // pending, no parcel
  const [booked] = await parcels(ctx, 1);
  fakeBills();

  const { printed, skipped } = await airwayBillsFor({
    business: ctx.biz._id,
    orderIds: [String(ctx.order._id), String(booked._id)]
  });
  assert.equal(printed.length, 1);
  assert.equal(skipped[0].orderNumber, ctx.order.orderNumber);
  assert.match(skipped[0].reason, /Not booked through a courier/);
});

test('none printable is a 400, and another business’s orders are never fetched', async () => {
  fakePostex();
  const ctx = await setupOrder();
  const otherBiz = await makeBusiness({ name: 'Other Biz' });
  const otherProduct = await makeProduct(otherBiz._id);
  const theirs = await Order.create({
    business: otherBiz._id,
    customer: oid(),
    customerName: 'Theirs',
    contactNumber: '03001234567',
    courier: ctx.courier._id,
    courierBooking: { provider: 'postex', trackingNumber: 'T-777' },
    status: 'dispatched',
    items: [
      {
        product: otherProduct._id,
        variantId: otherProduct.variants[0]._id,
        productName: 'x',
        quantity: 1,
        unitPrice: 1,
        unitCost: 1
      }
    ],
    codAmount: 1,
    createdBy: userId
  });
  const calls = fakeBills();

  await assert.rejects(
    airwayBillsFor({ business: ctx.biz._id, orderIds: [String(theirs._id)] }),
    err => err.statusCode === 400
  );
  assert.equal(calls.length, 0, 'the courier was never asked about it');
});

test('the endpoint returns a PDF, stamps the bills printed, and names skipped parcels in a header', async () => {
  fakePostex();
  const ctx = await setupOrder();
  const made = await parcels(ctx, 3);
  fakeBills({ badNumber: 2 });

  const sent = {};
  // This handler answers with send(), not json(), so it is called with a minimal res.
  await printAirwayBills(
    {
      user: admin,
      body: orderAirwayBillsSchema.parse({ business: String(ctx.biz._id), orderIds: ids(made) })
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

  assert.equal(sent.headers['Content-Type'], 'application/pdf');
  assert.match(sent.headers['Content-Disposition'], /airway-bills-\d{4}-\d{2}-\d{2}\.pdf/);
  assert.equal(sent.headers['X-Airway-Skipped'], `#${made[1].orderNumber}`);
  assert.deepEqual(await widthsOf(sent.body), [1, 3]);

  const [one, two, three] = await Promise.all(made.map(o => Order.findById(o._id)));
  assert.equal(one.courierBooking.billPrinted, true);
  assert.equal(three.courierBooking.billPrinted, true);
  assert.equal(
    two.courierBooking.billPrinted,
    undefined,
    'a bill that did not print is not marked'
  );
  assert.equal(String(one.courierBooking.billPrintedBy), String(userId));
});

test('the single bill also marks the parcel printed', async () => {
  fakePostex();
  const ctx = await setupOrder();
  await dispatchBooked(ctx.order, ctx.courier);
  const booked = await Order.findById(ctx.order._id);
  assert.equal(booked.courierBooking.billPrinted, false, 'a new booking starts as not printed');

  courierDeps.fetchImpl = async () =>
    new Response(await bill([1]), { status: 200, headers: { 'Content-Type': 'application/pdf' } });
  const res = {
    status() {
      return this;
    },
    set() {
      return this;
    },
    send() {}
  };
  await getAirwayBill({ resource: booked, user: admin }, res, e => {
    throw e;
  });
  await new Promise(r => setTimeout(r, 50));
  assert.equal((await Order.findById(ctx.order._id)).courierBooking.billPrinted, true);
});

test('the schema asks for at least one and at most 100 orders', () => {
  const ok = { business: 'b', orderIds: ['a'] };
  assert.equal(orderAirwayBillsSchema.safeParse(ok).success, true);
  assert.equal(orderAirwayBillsSchema.safeParse({ ...ok, orderIds: [] }).success, false);
  const many = Array.from({ length: 101 }, (_, i) => `id${i}`);
  assert.equal(orderAirwayBillsSchema.safeParse({ ...ok, orderIds: many }).success, false);
  assert.equal(
    orderAirwayBillsSchema.safeParse({ ...ok, orderIds: many.slice(0, 100) }).success,
    true
  );
});
