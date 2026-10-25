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
import JournalEntry from '../models/JournalEntry.js';
import '../models/Category.js';
import {
  createOrder,
  getOrder,
  updateOrderStatus,
  getDeliverers
} from '../controllers/orderController.js';
import { orderCreateSchema, orderStatusSchema } from '../schemas/orders.js';
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { accountBalance } from '../utils/ledger.js';
import { toPaisa } from '../utils/money.js';
import { courierPerformance } from '../utils/courierPerformance.js';
import { pakistanDay } from '../utils/pakistanDay.js';

/**
 * A parcel we take ourselves has no courier: no courier receivable, no 4% COD tax, no courier
 * invoice. The cash is taken at the door (or stays owed on the customer's khata), and what the
 * trip cost us is booked as a delivery expense.
 */
before(connect);
after(disconnect);
afterEach(clear);

const admin = { id: userId, role: { fullAccess: true } };

let n = 0;
const place = async () => {
  const biz = await makeBusiness({
    name: `Shop ${(n += 1)}`,
    codTax: { whtPercent: 2, salesTaxPercent: 2 }
  });
  const product = await makeProduct(biz._id);
  const out = await runHandler(createOrder, {
    user: admin,
    body: orderCreateSchema.parse({
      business: String(biz._id),
      customerName: 'Sana',
      contactNumber: '03004445555',
      items: [
        {
          product: String(product._id),
          variantId: String(product.variants[0]._id),
          quantity: 1,
          unitPrice: 5000
        }
      ]
    })
  });
  return { biz, order: await Order.findById(out.body.data._id) };
};

const move = (order, body) =>
  runHandler(updateOrderStatus, {
    user: admin,
    resource: order,
    body: orderStatusSchema.parse(body)
  });

const sendSelf = async (order, extra = {}) =>
  move(order, { status: 'dispatched', selfDelivery: true, deliveredBy: 'Ali', ...extra });

const balance = async (biz, code) =>
  accountBalance(biz._id, (await accountByCode(biz._id, code))._id);

test('dispatch needs no courier and no tracking number, only who is taking it', async () => {
  const { order } = await place();
  await sendSelf(order);
  const fresh = await Order.findById(order._id);
  assert.equal(fresh.status, 'dispatched');
  assert.equal(fresh.selfDelivery, true);
  assert.equal(fresh.deliveredBy, 'Ali');
  assert.equal(fresh.courier, undefined);
  assert.equal(fresh.trackingId, undefined);
});

test('a slip number made on TCS or PostEx is still kept, and a name is required', async () => {
  const { order } = await place();
  await assert.rejects(
    move(order, { status: 'dispatched', selfDelivery: true }),
    /who is delivering/
  );
  await sendSelf(await Order.findById(order._id), { trackingId: 'TCS777' });
  assert.equal((await Order.findById(order._id)).trackingId, 'TCS777');
});

test('a courier and "ourselves" together is refused', async () => {
  const { biz, order } = await place();
  const courier = await makeParty(biz._id, 'courier');
  await assert.rejects(sendSelf(order, { courier: String(courier._id) }), /has no courier/);
});

test('delivered with the cash collected: no tax, straight into Cash, marked paid', async () => {
  const { biz, order } = await place();
  await sendSelf(order);
  await move(await Order.findById(order._id), { status: 'delivered' });

  const fresh = await Order.findById(order._id);
  assert.equal(fresh.paymentStatus, 'paid');
  assert.equal(fresh.paidPaisa, toPaisa(5000));
  assert.equal(await balance(biz, CODES.CASH), toPaisa(5000), 'the whole COD, nothing withheld');
  assert.equal(await balance(biz, CODES.SALES_TAX), 0);
  assert.equal(await balance(biz, CODES.WITHHOLDING_TAX), 0);
  assert.equal(await balance(biz, CODES.COD_RECEIVABLE), 0, 'no courier owes us anything');
});

test('delivered but not collected: owed by the customer, order stays unpaid', async () => {
  const { biz, order } = await place();
  await sendSelf(order);
  await move(await Order.findById(order._id), { status: 'delivered', collected: false });

  const fresh = await Order.findById(order._id);
  assert.equal(fresh.paymentStatus, 'unpaid');
  assert.ok(fresh.customerParty, 'on the customer’s khata');
  assert.equal(await balance(biz, CODES.CASH), 0);
  assert.equal(await balance(biz, CODES.ACCOUNTS_RECEIVABLE), toPaisa(5000));
});

test('what the trip cost us is a delivery expense paid from Cash, with its note', async () => {
  const { biz, order } = await place();
  await sendSelf(order);
  await move(await Order.findById(order._id), {
    status: 'delivered',
    deliveryCharge: 600,
    note: 'petrol + toll'
  });

  assert.equal(await balance(biz, CODES.DELIVERY_CHARGES), toPaisa(600));
  assert.equal(await balance(biz, CODES.CASH), toPaisa(5000) - toPaisa(600));
  const memo = await JournalEntry.findOne({ business: biz._id, memo: /Delivery charge/ });
  assert.match(memo.memo, /petrol \+ toll/);
});

test('a real courier order still withholds the 2% + 2%', async () => {
  const { biz, order } = await place();
  const courier = await makeParty(biz._id, 'courier');
  await move(order, { status: 'dispatched', courier: String(courier._id), trackingId: 'T1' });
  await move(await Order.findById(order._id), { status: 'delivered', deliveryCharge: 0 });
  assert.equal(await balance(biz, CODES.SALES_TAX), toPaisa(100));
  assert.equal(await balance(biz, CODES.WITHHOLDING_TAX), toPaisa(100));
  assert.equal(await balance(biz, CODES.COD_RECEIVABLE), toPaisa(4800));
});

test('returned: the sale is undone and the trip back can be booked as a cost', async () => {
  const { biz, order } = await place();
  await sendSelf(order);
  await move(await Order.findById(order._id), { status: 'returned', deliveryCharge: 400 });
  assert.equal((await Order.findById(order._id)).status, 'returned');
  assert.equal(await balance(biz, CODES.RETURN_CHARGES), toPaisa(400));
});

test('delivered-by names already used are suggested, newest first, per business', async () => {
  const a = await place();
  await sendSelf(a.order, { deliveredBy: 'Ali' });
  const b = await place();
  await sendSelf(b.order, { deliveredBy: 'Bilal' });

  const out = await runHandler(getDeliverers, { query: { business: String(a.biz._id) } });
  assert.deepEqual(out.body.data, ['Ali']);
  await assert.rejects(
    runHandler(getDeliverers, {
      query: { business: String(a.biz._id) },
      accessFilter: { business: { $in: [oid()] } }
    }),
    /not found/
  );
});

test('the courier report keeps self parcels out of the couriers and lists them per person', async () => {
  const { biz, order } = await place();
  await sendSelf(order, { deliveredBy: 'Ali' });
  await move(await Order.findById(order._id), { status: 'delivered', deliveryCharge: 600 });
  const day = pakistanDay();
  const out = await courierPerformance(String(biz._id), { from: day, to: day, by: 'courier' });

  assert.equal(out.rows.length, 0, 'no courier row for a parcel we took ourselves');
  assert.equal(out.totals.dispatched, 0);
  assert.deepEqual(out.selfDelivery.rows, [
    {
      person: 'Ali',
      dispatched: 1,
      delivered: 1,
      returned: 0,
      inTransit: 0,
      costPaisa: toPaisa(600),
      costPerParcelPaisa: toPaisa(600),
      collectedPaisa: toPaisa(5000)
    }
  ]);
  assert.equal(out.selfDelivery.totals.costPaisa, toPaisa(600));
});

test('the order page preview shows the full COD, with no tax or courier fee, for a self parcel', async () => {
  const { order } = await place();
  await sendSelf(order);
  const out = await runHandler(getOrder, { resource: await Order.findById(order._id) });
  const r = out.body.data.remittance;
  assert.equal(r.selfDelivery, true);
  assert.equal(r.counterSale, false, 'not a counter sale — it ships later and takes advances');
  assert.equal(r.withholdingTax, 0);
  assert.equal(r.salesTax, 0);
  assert.equal(r.deliveryCharge, 0);
  assert.equal(r.netReceivable, 5000);
});
