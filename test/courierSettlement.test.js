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
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { partyBalance, accountBalance } from '../utils/ledger.js';
import { updateOrderStatus, updateOrderPayment } from '../controllers/orderController.js';
import { recordPartyTransaction } from '../controllers/partyController.js';
import { reverseJournalEntry } from '../controllers/financeController.js';
import { orderStatusSchema } from '../schemas/orders.js';
import { partyTransactionSchema } from '../schemas/parties.js';
import { toPaisa } from '../utils/money.js';

/**
 * A courier's weekly lump sum is booked once and marks its delivered orders
 * paid, oldest first, as far as the money covers — counting the charges the
 * courier already kept back. An order it doesn't fully cover stays unpaid.
 */

before(connect);
after(disconnect);
afterEach(clear);

/** A business (no COD taxes), a courier and a product with stock. */
async function setup() {
  // No FBR withholding, so each order nets exactly COD − delivery fee.
  const biz = await makeBusiness({ codTax: { whtPercent: 0, salesTaxPercent: 0 } });
  const courier = await makeParty(biz._id, 'courier', { name: 'TCS' });
  const product = await makeProduct(biz._id);
  return { biz, courier, product };
}

/** A dispatched order of `price`, then moved to `outcome` with `charge`. */
async function courierOrder({ biz, courier, product }, price, outcome, charge) {
  const variant = product.variants[0];
  const order = await Order.create({
    business: biz._id,
    customer: oid(),
    customerName: 'Ali',
    contactNumber: '03001234567',
    items: [
      {
        product: product._id,
        variantId: variant._id,
        productName: product.name,
        quantity: 1,
        unitPrice: price,
        unitCost: 0
      }
    ],
    courier: courier._id,
    trackingId: `TCS${price}`,
    status: 'dispatched',
    createdBy: userId
  });
  await runHandler(updateOrderStatus, {
    resource: order,
    body: orderStatusSchema.parse({ status: outcome, deliveryCharge: charge })
  });
  return order._id;
}

const courierPaid = (courier, amount) =>
  runHandler(recordPartyTransaction, {
    resource: courier,
    body: partyTransactionSchema.parse({ direction: 'got', amount, method: 'bank' })
  });

const statusOf = async ids =>
  Promise.all(ids.map(async id => (await Order.findById(id)).paymentStatus));

test('paying the whole balance marks every delivered order paid', async () => {
  const ctx = await setup();
  // Three deliveries netting 1,900 each (2,000 COD − 100 fee).
  const ids = [
    await courierOrder(ctx, 2000, 'delivered', 100),
    await courierOrder(ctx, 2000, 'delivered', 100),
    await courierOrder(ctx, 2000, 'delivered', 100)
  ];

  const out = await courierPaid(ctx.courier, 5700);
  assert.equal(out.body.data.settledOrders, 3);
  assert.equal(out.body.data.unpaidOrders, 0);
  assert.deepEqual(await statusOf(ids), ['paid', 'paid', 'paid']);
  assert.equal(await partyBalance(ctx.biz._id, ctx.courier._id), 0, 'courier squared');

  const bank = (await accountByCode(ctx.biz._id, CODES.BANK))._id;
  assert.equal(await accountBalance(ctx.biz._id, bank), toPaisa(5700), 'one bank deposit');
});

test('a part payment pays the oldest orders it fully covers, no more', async () => {
  const ctx = await setup();
  const ids = [
    await courierOrder(ctx, 2000, 'delivered', 100),
    await courierOrder(ctx, 2000, 'delivered', 100),
    await courierOrder(ctx, 2000, 'delivered', 100)
  ];

  // 3,000 covers the first (1,900) but not the first two (3,800).
  const out = await courierPaid(ctx.courier, 3000);
  assert.equal(out.body.data.settledOrders, 1);
  assert.equal(out.body.data.unpaidOrders, 2);
  assert.deepEqual(await statusOf(ids), ['paid', 'unpaid', 'unpaid']);
});

test('charges the courier already kept count towards the orders', async () => {
  const ctx = await setup();
  const ids = [
    await courierOrder(ctx, 2000, 'delivered', 100),
    await courierOrder(ctx, 2000, 'delivered', 100)
  ];
  // A refused parcel: the courier keeps 300 back from what it pays us.
  await courierOrder(ctx, 1500, 'returned', 300);

  // Owed 3,800 − 300 = 3,500; paying exactly that clears both deliveries.
  const out = await courierPaid(ctx.courier, 3500);
  assert.equal(out.body.data.settledOrders, 2);
  assert.deepEqual(await statusOf(ids), ['paid', 'paid']);
});

test('an order paid in a settlement can not be unmarked on its own', async () => {
  const ctx = await setup();
  const id = await courierOrder(ctx, 2000, 'delivered', 100);
  await courierPaid(ctx.courier, 1900);

  await assert.rejects(
    runHandler(updateOrderPayment, {
      resource: await Order.findById(id),
      body: { paymentStatus: 'unpaid' }
    }),
    /courier settlement/
  );
});

test('reversing the settlement un-pays its orders', async () => {
  const ctx = await setup();
  const ids = [
    await courierOrder(ctx, 2000, 'delivered', 100),
    await courierOrder(ctx, 2000, 'delivered', 100)
  ];
  const out = await courierPaid(ctx.courier, 3800);

  await runHandler(reverseJournalEntry, {
    resource: await JournalEntry.findById(out.body.data._id),
    body: {}
  });

  assert.deepEqual(await statusOf(ids), ['unpaid', 'unpaid']);
  assert.equal(
    await partyBalance(ctx.biz._id, ctx.courier._id),
    toPaisa(3800),
    'courier owes it all again'
  );
  const again = await Order.findById(ids[0]);
  assert.equal(again.courierSettlement, undefined, 'link cleared');
});

test('with FBR taxes on, paying exactly the balance still clears every order', async () => {
  const biz = await makeBusiness(); // default WHT + sales tax
  const courier = await makeParty(biz._id, 'courier', { name: 'Leopards' });
  const product = await makeProduct(biz._id);
  const ctx = { biz, courier, product };
  const ids = [
    await courierOrder(ctx, 2000, 'delivered', 100),
    await courierOrder(ctx, 3500, 'delivered', 150)
  ];

  const owed = (await partyBalance(biz._id, courier._id)) / 100;
  const out = await courierPaid(courier, owed);

  assert.equal(out.body.data.settledOrders, 2);
  assert.deepEqual(await statusOf(ids), ['paid', 'paid']);
  assert.equal(await partyBalance(biz._id, courier._id), 0);
});
