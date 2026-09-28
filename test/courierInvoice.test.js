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
import CourierInvoice from '../models/CourierInvoice.js';
import Party from '../models/Party.js';
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { partyBalance, accountBalance } from '../utils/ledger.js';
import { updateOrderStatus, updateOrderPayment } from '../controllers/orderController.js';
import { getCourierItems, createCourierInvoice } from '../controllers/courierInvoiceController.js';
import { reverseJournalEntry } from '../controllers/financeController.js';
import { orderStatusSchema } from '../schemas/orders.js';
import { courierInvoiceSchema } from '../schemas/parties.js';
import { toPaisa } from '../utils/money.js';
import { profitAndLoss } from '../utils/reports.js';

/**
 * The courier's weekly invoice settles two things per parcel, independently:
 * its COD and its charge. TCS may bill a parcel's charge one week and pay its
 * COD the next, so each must be tickable on its own.
 *
 * Every order here is a 2000 COD; at 2% + 2% the courier owes 1920 net.
 */

before(connect);
after(disconnect);
afterEach(clear);

let seq = 0;

async function setup() {
  const biz = await makeBusiness();
  const courier = await makeParty(biz._id, 'courier');
  const product = await makeProduct(biz._id);
  return { biz, courier, product };
}

async function parcel({ biz, courier, product }, outcome = 'delivered') {
  seq += 1;
  const variant = product.variants[0];
  const order = await Order.create({
    business: biz._id,
    customer: oid(),
    customerName: `Customer ${seq}`,
    contactNumber: '03001234567',
    items: [
      {
        product: product._id,
        variantId: variant._id,
        productName: product.name,
        quantity: 1,
        unitPrice: 2000,
        unitCost: 1000
      }
    ],
    courier: courier._id,
    trackingId: `TRK${seq}`,
    status: 'dispatched',
    createdBy: userId
  });
  const out = await runHandler(updateOrderStatus, {
    resource: order,
    body: orderStatusSchema.parse({ status: outcome })
  });
  return Order.findById(out.body.data._id);
}

const items = async courier =>
  (await runHandler(getCourierItems, { resource: courier })).body.data.items;

const invoice = async (courier, body) =>
  runHandler(createCourierInvoice, {
    resource: await Party.findById(courier._id),
    body: courierInvoiceSchema.parse({ invoiceDate: '2026-09-20', ...body })
  });

const cashAccount = async biz => String((await accountByCode(biz._id, CODES.CASH))._id);

test('a delivered parcel is open for its COD and its charge; a return for its charge', async () => {
  const ctx = await setup();
  const delivered = await parcel(ctx);
  const returned = await parcel(ctx, 'returned');

  const open = await items(ctx.courier);
  const d = open.find(i => String(i.order) === String(delivered._id));
  const r = open.find(i => String(i.order) === String(returned._id));
  assert.deepEqual(d.cod, { cod: 2000, withholdingTax: 40, salesTax: 40, net: 1920 });
  assert.equal(d.deliveryChargeOpen, true);
  assert.equal(r.cod, null);
  assert.equal(r.returnChargeOpen, true);
});

test('TCS style: charges billed one week, the COD paid the next', async () => {
  const ctx = await setup();
  const order = await parcel(ctx);
  const cash = await cashAccount(ctx.biz);

  // Week 1 — only the charge, deducted from other money: nothing arrives.
  const week1 = await invoice(ctx.courier, {
    invoiceNumber: 'INV-1',
    charges: [{ order: String(order._id), kind: 'delivery', amount: 180 }]
  });
  assert.equal(week1.body.data.expected, -180);
  let after1 = await Order.findById(order._id);
  assert.equal(after1.deliveryChargePaisa, toPaisa(180));
  assert.equal(after1.paymentStatus, 'unpaid', 'COD still owed');

  const deliveryAcc = (await accountByCode(ctx.biz._id, CODES.DELIVERY_CHARGES))._id;
  assert.equal(await accountBalance(ctx.biz._id, deliveryAcc), toPaisa(180));

  // Week 2 — the COD, paid into cash.
  const week2 = await invoice(ctx.courier, {
    invoiceNumber: 'INV-2',
    received: 1920,
    account: cash,
    cod: [String(order._id)]
  });
  assert.equal(week2.body.data.difference, 0);
  after1 = await Order.findById(order._id);
  assert.equal(after1.paymentStatus, 'paid');

  // It paid the full 1920 but billed 180 it had nothing to deduct from yet, so
  // we now owe it 180 — it will come off its next invoice.
  assert.equal(await partyBalance(ctx.biz._id, ctx.courier._id), -toPaisa(180));
  assert.equal((await items(ctx.courier)).length, 0, 'nothing left open');

  const courier = await Party.findById(ctx.courier._id);
  assert.equal(String(courier.defaultMoneyAccount), cash, 'remembers where the money landed');
});

test('COD and charge on one invoice: expected is net minus the charge', async () => {
  const ctx = await setup();
  const a = await parcel(ctx);
  const b = await parcel(ctx, 'returned');

  const out = await invoice(ctx.courier, {
    invoiceNumber: 'PX-77',
    received: 1650,
    account: await cashAccount(ctx.biz),
    cod: [String(a._id)],
    charges: [
      { order: String(a._id), kind: 'delivery', amount: 150 },
      { order: String(b._id), kind: 'return', amount: 120 }
    ]
  });
  assert.equal(out.body.data.expected, 1920 - 150 - 120);
  assert.equal(out.body.data.difference, 0);
  assert.equal(await partyBalance(ctx.biz._id, ctx.courier._id), 0, 'courier square');

  const entry = await JournalEntry.findById(out.body.data.invoice.entry);
  assert.ok(entry.lines.some(l => /Delivery charge/.test(l.label)));
  assert.ok(entry.lines.some(l => /Return charge/.test(l.label)));
});

test('a short payment stays on the courier balance', async () => {
  const ctx = await setup();
  const a = await parcel(ctx);
  const out = await invoice(ctx.courier, {
    invoiceNumber: 'S-1',
    received: 1700,
    account: await cashAccount(ctx.biz),
    cod: [String(a._id)],
    charges: [{ order: String(a._id), kind: 'delivery', amount: 200 }]
  });
  assert.equal(out.body.data.difference, -20);
  assert.equal(
    await partyBalance(ctx.biz._id, ctx.courier._id),
    toPaisa(20),
    'courier still owes 20'
  );
});

test('the same invoice number is refused, and so is an already-settled item', async () => {
  const ctx = await setup();
  const a = await parcel(ctx);
  const b = await parcel(ctx);
  await invoice(ctx.courier, {
    invoiceNumber: 'DUP',
    charges: [{ order: String(a._id), kind: 'delivery', amount: 100 }]
  });

  await assert.rejects(
    invoice(ctx.courier, {
      invoiceNumber: 'DUP',
      charges: [{ order: String(b._id), kind: 'delivery', amount: 100 }]
    }),
    /already recorded/
  );
  await assert.rejects(
    invoice(ctx.courier, {
      invoiceNumber: 'OTHER',
      charges: [{ order: String(a._id), kind: 'delivery', amount: 100 }]
    }),
    /no open delivery charge/
  );
  await assert.rejects(invoice(ctx.courier, { invoiceNumber: 'EMPTY' }), /Tick the parcels/);
});

test("another courier's parcel can not be settled", async () => {
  const ctx = await setup();
  const a = await parcel(ctx);
  const other = await makeParty(ctx.biz._id, 'courier', { name: 'Other Courier' });
  await assert.rejects(
    invoice(other, {
      invoiceNumber: 'X',
      charges: [{ order: String(a._id), kind: 'delivery', amount: 100 }]
    }),
    /no open delivery charge/
  );
});

test('reversing an invoice reopens its CODs and charges and frees its number', async () => {
  const ctx = await setup();
  const a = await parcel(ctx);
  const out = await invoice(ctx.courier, {
    invoiceNumber: 'REV',
    received: 1740,
    account: await cashAccount(ctx.biz),
    cod: [String(a._id)],
    charges: [{ order: String(a._id), kind: 'delivery', amount: 180 }]
  });
  const entry = await JournalEntry.findById(out.body.data.invoice.entry);
  await runHandler(reverseJournalEntry, { resource: entry, body: {} });

  const reopened = await Order.findById(a._id);
  assert.equal(reopened.paymentStatus, 'unpaid');
  assert.equal(reopened.deliveryChargePaisa, undefined);
  assert.equal(await CourierInvoice.countDocuments(), 0);
  assert.equal((await items(ctx.courier)).length, 1);

  // The number can now be entered again, correctly.
  await invoice(ctx.courier, {
    invoiceNumber: 'REV',
    received: 1720,
    account: await cashAccount(ctx.biz),
    cod: [String(a._id)],
    charges: [{ order: String(a._id), kind: 'delivery', amount: 200 }]
  });
});

test('a courier parcel is marked paid through its invoice, not by hand', async () => {
  const ctx = await setup();
  const a = await parcel(ctx);
  await assert.rejects(
    runHandler(updateOrderPayment, { resource: a, body: { paymentStatus: 'paid' } }),
    /courier's invoice/
  );
});

test('profit says how many parcels still wait for the courier to bill them', async () => {
  const ctx = await setup();
  const a = await parcel(ctx);
  await parcel(ctx, 'returned');
  assert.equal((await profitAndLoss(ctx.biz._id)).unbilledCharges, 2);

  await invoice(ctx.courier, {
    invoiceNumber: 'P-1',
    charges: [{ order: String(a._id), kind: 'delivery', amount: 150 }]
  });
  assert.equal((await profitAndLoss(ctx.biz._id)).unbilledCharges, 1);
});
