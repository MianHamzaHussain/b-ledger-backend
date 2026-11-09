import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect } from './helpers/db.js';
import Order from '../models/Order.js';
import Business from '../models/Business.js';
import CourierReceipt from '../models/CourierReceipt.js';
import { clearCityCache } from '../utils/couriers/booking.js';
import { costsFor, grossUpCod, parcelCost, taxPercentOf } from '../utils/courierCosts.js';
import { admin, deliveredParcel, restoreFetch } from './helpers/courier.js';

/**
 * What the courier charges for a customer's parcels, so a refund or an exchange recovers it. The tax is on the
 * parcel's COD only; PostEx's receipt beats every other figure and is the only thing (with a courier invoice) that
 * makes a cost final.
 */
before(connect);
after(disconnect);
afterEach(async () => {
  restoreFetch();
  clearCityCache();
  await clear();
});

const FOUR = { whtPercent: 2, salesTaxPercent: 2 };

test('the COD is grossed up to a whole rupee that still covers the base after its own tax', () => {
  assert.equal(grossUpCod(117650, 4), 122600); // 1,176.50 → 1,226
  assert.equal(grossUpCod(401650, 4), 418400); // 4,016.50 → 4,184
  assert.equal(grossUpCod(0, 4), 0);
  assert.equal(grossUpCod(-500, 4), 0);
  assert.equal(grossUpCod(10000, 0), 10000);
  for (const base of [1, 99, 12345, 100000, 7654321]) {
    const cod = grossUpCod(base, 4);
    assert.ok(cod - Math.round(cod * 0.04) >= base, `${cod} covers ${base}`);
    assert.ok(cod - 100 - Math.round((cod - 100) * 0.04) < base, `${cod} is the smallest`);
  }
});

test('the 4 % is the two COD taxes added together', () => {
  assert.equal(taxPercentOf(FOUR), 4);
  assert.equal(taxPercentOf({}), 0);
});

test('the tax is on the COD only — an advance carries none — and a receipt beats the status check', () => {
  // 15,000 order: 1,000 paid to us as an advance, 14,000 COD. Tax is 4 % of 14,000, not of 15,000.
  const order = { codAmount: 14000, deliveryChargePaisa: 26825 };
  const tracked = parcelCost(order, { codTax: FOUR });
  assert.equal(tracked.taxPaisa, 56000);
  assert.deepEqual([tracked.source, tracked.isFinal], ['tracking', false]);

  const invoiced = parcelCost(order, { codTax: FOUR, fromInvoice: true });
  assert.deepEqual([invoiced.source, invoiced.isFinal], ['invoice', true]);

  const receipt = parcelCost(order, {
    codTax: FOUR,
    receiptRow: { shippingPaisa: 23000, gstPaisa: 3825, deductionPaisa: 56000 }
  });
  assert.deepEqual(
    [receipt.deliveryPaisa, receipt.taxPaisa, receipt.source, receipt.isFinal],
    [26825, 56000, 'receipt', true]
  );

  const unknown = parcelCost({ codAmount: 14000 }, { codTax: FOUR, estimateDeliveryPaisa: 26825 });
  assert.deepEqual(
    [unknown.deliveryPaisa, unknown.source, unknown.isFinal],
    [26825, 'estimate', false]
  );
});

const refunded = async ({ by = 'customer' } = {}) => {
  const made = await deliveredParcel({ paid: false, codTax: FOUR });
  await Business.updateOne({ _id: made.biz._id }, { $set: { codTax: FOUR } });
  await Order.updateOne(
    { _id: made.order._id },
    {
      $set: {
        status: 'refunded',
        returnShipping: { by },
        ...(by === 'us' ? { returnChargePaisa: 13900, reversalTrackingId: 'RV-1' } : {})
      }
    }
  );
  return made;
};
const lean = made => Order.findById(made.order._id).lean();

test('a refunded parcel costs its delivery charge and its tax; the customer’s own return courier costs us nothing', async () => {
  const made = await refunded();
  const out = await costsFor(await lean(made));
  // COD 4,000: delivery 209.00 (fee 180 + tax 29 from the status check), tax 4 % = 160.00.
  assert.deepEqual(
    out.lines.map(l => [l.label, l.amountPaisa]),
    [
      ['Delivery charge — parcel #' + made.order.orderNumber, 20900],
      ['4 % tax on COD — parcel #' + made.order.orderNumber, 16000]
    ]
  );
  assert.equal(out.totalPaisa, 36900);
  assert.equal(out.isFinal, false, 'only the status check has said so — not PostEx’s receipt');
});

test('a pickup we booked on our own courier is a cost too; a receipt makes the parcel final', async () => {
  const made = await refunded({ by: 'us' });
  const before = await costsFor(await lean(made));
  assert.equal(before.lines.at(-1).label, 'Return pickup');
  assert.equal(before.lines.at(-1).amountPaisa, 13900);
  assert.equal(before.isFinal, false);

  await CourierReceipt.create({
    business: made.biz._id,
    courier: made.courier._id,
    cprNumber: 'CPR-C1',
    cprDate: new Date(),
    rows: [
      {
        tracking: 'CX-1001',
        status: 'delivered',
        codPaisa: 400000,
        shippingPaisa: 18000,
        gstPaisa: 2900,
        deductionPaisa: 16000,
        netPaisa: 363100,
        order: made.order._id,
        outcome: 'applied'
      },
      {
        tracking: 'RV-1',
        status: 'returned',
        codPaisa: 0,
        shippingPaisa: 12000,
        gstPaisa: 1900,
        deductionPaisa: 0,
        netPaisa: -13900,
        outcome: 'applied'
      }
    ],
    importedBy: admin.id
  });
  const after = await costsFor(await lean(made));
  assert.equal(after.isFinal, true);
  assert.equal(after.totalPaisa, 20900 + 16000 + 13900);
});

test('an order that is neither refunded nor a replacement has no costs to recover', async () => {
  const made = await deliveredParcel({ paid: false });
  const out = await costsFor(await lean(made));
  assert.deepEqual(out, { lines: [], totalPaisa: 0, isFinal: true, waitingFor: [] });
});
