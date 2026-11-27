import assert from 'node:assert/strict';
import { makeBusiness, makeProduct, makeParty, runHandler } from './db.js';
import Order from '../../models/Order.js';
import Product from '../../models/Product.js';
import JournalEntry from '../../models/JournalEntry.js';
import { accountByCode, CODES } from '../../utils/chartOfAccounts.js';
import { accountBalance, trialBalance } from '../../utils/ledger.js';
import { createOrder, updateOrderStatus, swapOrder } from '../../controllers/orderController.js';
import { orderCreateSchema, orderStatusSchema, orderSwapSchema } from '../../schemas/orders.js';

/** Shared by the exchange suites: a business, a delivered two-item order (#0204), and the ledger checks. */
let seq = 0;

export async function setup() {
  const biz = await makeBusiness();
  const product = await makeProduct(biz._id, [
    { label: 'M', costPrice: 1000, salePrice: 3000, stock: 10 },
    { label: 'L', costPrice: 1000, salePrice: 3000, stock: 10 },
    { label: 'S', costPrice: 1000, salePrice: 3000, stock: 10 }
  ]);
  const courier = await makeParty(biz._id, 'courier');
  const acc = async code => (await accountByCode(biz._id, code))._id;
  return { biz, product, courier, cash: String(await acc(CODES.CASH)), acc };
}

export const variantId = (ctx, label) =>
  String(ctx.product.variants.find(v => v.label === label)._id);
export const item = (ctx, label, price) => ({
  product: String(ctx.product._id),
  variantId: variantId(ctx, label),
  quantity: 1,
  unitPrice: price
});

export const setStatus = (order, body) =>
  runHandler(updateOrderStatus, { resource: order, body: orderStatusSchema.parse(body) }).then(r =>
    Order.findById(r.body.data._id)
  );

/** Order #0204: M at 16,000 and L at 9,000, delivered with a 268.25 delivery charge. */
export async function shakira(ctx) {
  seq += 1;
  const out = await runHandler(createOrder, {
    body: orderCreateSchema.parse({
      business: String(ctx.biz._id),
      customerName: 'Shakira Bano',
      contactNumber: '03001112222',
      items: [item(ctx, 'M', 16000), item(ctx, 'L', 9000)]
    })
  });
  let order = await Order.findById(out.body.data._id);
  order = await setStatus(order, {
    status: 'dispatched',
    courier: String(ctx.courier._id),
    trackingId: `TRK${seq}`
  });
  return setStatus(order, { status: 'delivered', deliveryCharge: 268.25 });
}

export const stockOf = async (ctx, label) =>
  (await Product.findById(ctx.product._id)).variants.find(v => v.label === label).stock;
export const bal = async (ctx, code) => accountBalance(ctx.biz._id, await ctx.acc(code));
export const lineOf = (order, index) => String(order.items[index]._id);

export async function everyEntryBalances(ctx) {
  for (const e of await JournalEntry.find({ business: ctx.biz._id })) {
    const debit = e.lines.reduce((s, l) => s + l.debitPaisa, 0);
    const credit = e.lines.reduce((s, l) => s + l.creditPaisa, 0);
    assert.equal(debit, credit, `"${e.memo}" balances`);
  }
  assert.equal((await trialBalance(ctx.biz._id)).balanced, true);
}

export const swap = (ctx, original, body) =>
  runHandler(swapOrder, {
    resource: original,
    body: orderSwapSchema.parse({ differenceAccount: ctx.cash, ...body })
  }).then(r => Order.findById(r.body.data._id));
