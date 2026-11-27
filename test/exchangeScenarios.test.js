import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, runHandler } from './helpers/db.js';
import { setup, item, shakira, bal, lineOf, everyEntryBalances, swap } from './helpers/exchange.js';
import Order from '../models/Order.js';
import { CODES } from '../utils/chartOfAccounts.js';
import {
  addOrderRefund,
  createReplacement,
  exchangeReturn,
  getExchangeQuote
} from '../controllers/orderController.js';
import {
  orderExchangeReturnSchema,
  orderRefundSchema,
  orderReplacementSchema
} from '../schemas/orders.js';

/**
 * The delivery charge AGREED with the customer, end to end (owner's note, 2026-11-27). The customer pays the price
 * difference plus exactly what was agreed (Rs 300, 500…) — on the replacement's COD when the item came back first, in
 * advance on a swap (whose COD is always 0). The courier's expected cost is covered first; what is left is the shop's extra
 * income, and a charge below the cost is the shop's to bear. The fixture: the original parcel cost Rs 268.25 to deliver,
 * the COD tax is 4 %.
 */
before(connect);
after(disconnect);
afterEach(clear);

/** Order #0204 with its Rs 16,000 item (M) sent back for an exchange, waiting for its replacement. */
async function backFirst(ctx) {
  const original = await shakira(ctx);
  return runHandler(exchangeReturn, {
    resource: original,
    body: orderExchangeReturnSchema.parse({ lines: [{ line: lineOf(original, 0), quantity: 1 }] })
  }).then(r => Order.findById(r.body.data._id));
}

const replace = (back, body) =>
  runHandler(createReplacement, { resource: back, body: orderReplacementSchema.parse(body) }).then(
    r => Order.findById(r.body.data._id)
  );

const quote = async (ctx, original, query) =>
  (await runHandler(getExchangeQuote, { resource: original, query })).body.data;

test('item came back, same price, agreed Rs 500: COD 500, the courier’s 288.25 covered, 211.75 is extra income', async () => {
  const ctx = await setup();
  const back = await backFirst(ctx);
  const replacement = await replace(back, { items: [item(ctx, 'S', 16000)], deliveryCharge: 500 });
  assert.equal(replacement.codAmount, 500);
  assert.equal(await bal(ctx, CODES.CHARGES_KEPT), -28825, '268.25 delivery + 20 tax on the COD');
  assert.equal(await bal(ctx, CODES.DELIVERY_INCOME), -21175);
  assert.ok(replacement.courierCosts.settledAt, 'settled at once: nothing waits for PostEx');
  assert.equal(replacement.refundDuePaisa, 0);
  await everyEntryBalances(ctx);
});

test('item came back, agreed Rs 200 — less than the courier costs: the customer pays 200, the shop bears the rest', async () => {
  const ctx = await setup();
  const replacement = await replace(await backFirst(ctx), {
    items: [item(ctx, 'S', 16000)],
    deliveryCharge: 200
  });
  assert.equal(replacement.codAmount, 200);
  assert.equal(await bal(ctx, CODES.CHARGES_KEPT), -20000);
  assert.equal(await bal(ctx, CODES.DELIVERY_INCOME), 0);
  await everyEntryBalances(ctx);
});

test('item came back, dearer replacement, agreed Rs 300: COD is the difference plus 300', async () => {
  const ctx = await setup();
  const replacement = await replace(await backFirst(ctx), {
    items: [item(ctx, 'S', 20000)],
    deliveryCharge: 300
  });
  assert.equal(replacement.codAmount, 4300);
  assert.equal(await bal(ctx, CODES.CHARGES_KEPT), -30000);
  assert.equal(await bal(ctx, CODES.DELIVERY_INCOME), 0);
  await everyEntryBalances(ctx);
});

test('item came back, cheaper replacement, agreed Rs 300: no COD, the difference less 300 is paid back at once', async () => {
  const ctx = await setup();
  const replacement = await replace(await backFirst(ctx), {
    items: [item(ctx, 'S', 11000)],
    deliveryCharge: 300
  });
  assert.equal(replacement.codAmount, 0);
  assert.equal(replacement.refundDuePaisa, 470000, '5,000 less the 300 charge');
  assert.equal(await bal(ctx, CODES.CHARGES_KEPT), -26825, 'the courier’s 268.25 (no COD, no tax)');
  assert.equal(await bal(ctx, CODES.DELIVERY_INCOME), -3175, 'the rest of the 300');
  // Nothing waits for PostEx: the customer's 4,700 can be paid now.
  const paid = await runHandler(addOrderRefund, {
    resource: replacement,
    body: orderRefundSchema.parse({ amount: 4700, account: ctx.cash })
  }).then(r => Order.findById(r.body.data._id));
  assert.equal(paid.refundDuePaisa, 0);
  await everyEntryBalances(ctx);
});

test('swap, dearer replacement, agreed Rs 300: the customer pays 4,300 before it goes, COD stays 0', async () => {
  const ctx = await setup();
  const original = await shakira(ctx);
  const replacement = await swap(ctx, original, {
    lines: [{ line: lineOf(original, 0), quantity: 1 }],
    items: [item(ctx, 'S', 20000)],
    deliveryCharge: 300
  });
  assert.equal(replacement.codAmount, 0);
  assert.equal(replacement.customerMoney.find(m => m.kind === 'advance').amountPaisa, 430000);
  assert.equal(await bal(ctx, CODES.CASH), 430000);
  assert.equal(await bal(ctx, CODES.CHARGES_KEPT), -26825);
  assert.equal(await bal(ctx, CODES.DELIVERY_INCOME), -3175);
  await everyEntryBalances(ctx);
});

test('swap, cheaper replacement, agreed Rs 300: the customer pays nothing and is owed the difference less 300', async () => {
  const ctx = await setup();
  const original = await shakira(ctx);
  const replacement = await swap(ctx, original, {
    lines: [{ line: lineOf(original, 0), quantity: 1 }],
    items: [item(ctx, 'S', 11000)],
    deliveryCharge: 300
  });
  assert.equal(replacement.codAmount, 0);
  assert.equal(replacement.customerMoney.filter(m => m.kind === 'advance').length, 0);
  assert.equal(replacement.refundDuePaisa, 470000);
  await everyEntryBalances(ctx);
});

test('the quote says what the customer pays and who bears the courier, in rupees', async () => {
  const ctx = await setup();
  const original = await shakira(ctx);
  const lines = `${lineOf(original, 0)}:1`;
  const agreed = await quote(ctx, original, { total: '16000', lines, charge: '500' });
  assert.equal(agreed.agreed, true);
  assert.equal(agreed.cod, 500);
  assert.equal(agreed.costs, 288.25);
  assert.equal(agreed.extra, 211.75);
  assert.equal(agreed.shopPays, 0);

  const cheap = await quote(ctx, original, { total: '16000', lines, charge: '200' });
  assert.equal(cheap.shopPays, 76.25);
  assert.equal(cheap.extra, 0);

  const swapped = await quote(ctx, original, {
    total: '16000',
    lines,
    charge: '500',
    swap: 'true'
  });
  assert.equal(swapped.pays, 500);
  assert.equal(swapped.cod, 0);

  const refunded = await quote(ctx, original, { total: '11000', lines, charge: '300' });
  assert.equal(refunded.owedBack, 4700);

  await assert.rejects(
    runHandler(getExchangeQuote, {
      resource: original,
      query: { total: '16000', lines, charge: '500', free: 'true' }
    }),
    /Choose one/
  );
});

test('an agreed charge must be more than nothing and can not be combined with free delivery', () => {
  assert.throws(() => orderReplacementSchema.parse({ items: [{}], deliveryCharge: 0 }));
  assert.throws(
    () =>
      orderReplacementSchema.parse({
        items: [{ product: 'a'.repeat(24), variantId: 'b'.repeat(24), quantity: 1, unitPrice: 1 }],
        deliveryCharge: 300,
        freeCourier: true,
        freeReason: 'faulty'
      }),
    /Choose one/
  );
});
