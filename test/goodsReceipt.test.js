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
import Product from '../models/Product.js';
import GoodsReceipt from '../models/GoodsReceipt.js';
import JournalEntry from '../models/JournalEntry.js';
import PeriodLock from '../models/PeriodLock.js';
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { accountBalance, partyBalance, partyStatement } from '../utils/ledger.js';
import { toPaisa } from '../utils/money.js';
import { hideCosts } from '../middlewares/permissions.js';
import {
  createGoodsReceipt,
  getGoodsReceipt,
  returnGoods,
  undoGoodsReceipt
} from '../controllers/goodsReceiptController.js';
import { reversePartyEntry } from '../controllers/partyController.js';
import { goodsReceiptCreateSchema, goodsReceiptReturnSchema } from '../schemas/goodsReceipts.js';

/**
 * Finished goods bought outright from a supplier. The rules worth pinning: the
 * bill lands on the supplier's Khata (with a Bill and a Paid row if paid now);
 * a send-back is credited at what the supplier BILLED, not today's average; the
 * stock's value and the Inventory account move together; only what is still on
 * the shelf can go back; and an undo is only possible while nothing was touched.
 */

before(connect);
after(disconnect);
afterEach(clear);

const admin = { id: userId, role: { fullAccess: true } };
const rupees = n => n * 100;

async function setup() {
  const biz = await makeBusiness();
  const supplier = await makeParty(biz._id, 'supplier', { name: 'Bilal Fabrics' });
  // M already holds 10 at 1,000 (opening stock, no ledger entry); L is empty.
  const product = await makeProduct(biz._id, [
    { label: 'M', costPrice: 1000, salePrice: 2000, stock: 10 },
    { label: 'L', costPrice: 0, salePrice: 2000, stock: 0 }
  ]);
  const idOf = label => String(product.variants.find(v => v.label === label)._id);
  return { biz, supplier, product, idOf };
}

const variantOf = async (ctx, label, product = ctx.product) =>
  (await Product.findById(product._id)).variants.find(v => v.label === label);

const inventory = async ctx =>
  accountBalance(ctx.biz._id, (await accountByCode(ctx.biz._id, CODES.INVENTORY))._id);
const cash = async ctx =>
  accountBalance(ctx.biz._id, (await accountByCode(ctx.biz._id, CODES.CASH))._id);
const owed = ctx => partyBalance(ctx.biz._id, ctx.supplier._id);

/** Σ stock × cost over the business's products, in paisa — what the shelf is worth. */
const shelfValue = async ctx => {
  const products = await Product.find({ business: ctx.biz._id });
  return products.reduce(
    (sum, p) => sum + p.variants.reduce((s, v) => s + toPaisa(v.costPrice) * v.stock, 0),
    0
  );
};

const receive = (ctx, body, extra = {}) =>
  runHandler(createGoodsReceipt, {
    user: admin,
    body: goodsReceiptCreateSchema.parse({
      business: String(ctx.biz._id),
      party: String(ctx.supplier._id),
      ...body
    }),
    ...extra
  }).then(r => r.body.data);

/** 10 more of M at 1,200 each — the average moves to 1,100 over 20. */
const tenMoreOfM = (ctx, extra = {}) =>
  receive(ctx, {
    lines: [
      { product: String(ctx.product._id), variantId: ctx.idOf('M'), quantity: 10, unitCost: 1200 }
    ],
    ...extra
  });

const sendBack = (ctx, receipt, lines, extra = {}) =>
  runHandler(returnGoods, {
    user: admin,
    resource: extra.resource ?? receipt,
    body: goodsReceiptReturnSchema.parse({ lines })
  }).then(r => r.body.data);

const reload = id => GoodsReceipt.findById(id);

test('goods on credit: stock and average cost go up, Inventory rises, the supplier is owed', async () => {
  const ctx = await setup();
  const inv0 = await inventory(ctx);
  const value0 = await shelfValue(ctx);

  const receipt = await tenMoreOfM(ctx);
  assert.equal(receipt.totalCostPaisa, rupees(12000));
  assert.equal(receipt.paidNowPaisa, 0);
  assert.match(receipt.receiptNumber, /^\d{4}$/);

  const m = await variantOf(ctx, 'M');
  assert.equal(m.stock, 20);
  assert.equal(m.costPrice, 1100, '(10 × 1,000 + 10 × 1,200) ÷ 20');

  assert.equal((await inventory(ctx)) - inv0, rupees(12000));
  assert.equal(await owed(ctx), -rupees(12000), 'owed to the supplier');
  assert.equal(
    (await shelfValue(ctx)) - value0,
    rupees(12000),
    'the shelf is worth exactly what the books say'
  );
  assert.equal((await Product.findById(ctx.product._id)).totalStock, 20);
});

test('paid now: the supplier’s Khata shows a Bill and a Paid row and the money leaves', async () => {
  const ctx = await setup();
  const cash0 = await cash(ctx);
  const receipt = await tenMoreOfM(ctx, { paidNow: 4000, method: 'cash' });

  assert.equal(receipt.paidNowPaisa, rupees(4000));
  assert.equal(receipt.paidFrom, 'Cash');
  assert.equal(await owed(ctx), -rupees(8000), 'still owed');
  assert.equal((await cash(ctx)) - cash0, -rupees(4000));

  const { rows } = await partyStatement(ctx.biz._id, ctx.supplier._id);
  assert.ok(rows.some(r => r.memo.startsWith('Bill — Goods from Bilal Fabrics')));
  assert.ok(rows.some(r => r.memo.startsWith('Paid — Goods from Bilal Fabrics')));
});

test('paid in full now leaves nothing owed, but the history is complete', async () => {
  const ctx = await setup();
  await tenMoreOfM(ctx, { paidNow: 12000, method: 'cash' });
  assert.equal(await owed(ctx), 0);
  const { rows } = await partyStatement(ctx.biz._id, ctx.supplier._id);
  assert.equal(rows.length, 2);
});

test('a new article is created with an article number, its sizes, stock and cost', async () => {
  const ctx = await setup();
  const receipt = await receive(ctx, {
    lines: [
      {
        newProduct: {
          name: 'Silk Kurta',
          variants: [
            { label: 'S', salePrice: 5000, quantity: 4, unitCost: 3000 },
            { label: 'M', salePrice: 5200, quantity: 6, unitCost: 3100 }
          ]
        }
      }
    ]
  });

  assert.equal(receipt.lines.length, 2);
  assert.ok(receipt.lines.every(l => l.createdProduct && l.articleNumber));
  const product = await Product.findById(receipt.lines[0].product);
  assert.equal(product.name, 'Silk Kurta');
  assert.match(product.articleNumber, /^[A-Z0-9]{4}$/);
  const s = product.variants.find(v => v.label === 'S');
  assert.deepEqual([s.stock, s.costPrice, s.salePrice], [4, 3000, 5000]);
  assert.equal(product.totalStock, 10);
  assert.equal(await owed(ctx), -(4 * rupees(3000) + 6 * rupees(3100)));
});

test('a send-back is credited at the receipt’s cost, not today’s average, and the books stay in step', async () => {
  const ctx = await setup();
  const inv0 = await inventory(ctx);
  const value0 = await shelfValue(ctx);
  const receipt = await tenMoreOfM(ctx);
  const line = receipt.lines[0];

  const after = await sendBack(ctx, await reload(receipt._id), [
    { lineId: String(line._id), quantity: 4 }
  ]);

  const m = await variantOf(ctx, 'M');
  assert.equal(m.stock, 16);
  assert.equal(m.costPrice, 1075, '(22,000 − 4 × 1,200) ÷ 16');
  assert.equal(await owed(ctx), -rupees(12000 - 4800), 'credited 4 × 1,200, not 4 × 1,100');
  assert.equal((await inventory(ctx)) - inv0, rupees(12000 - 4800));
  assert.equal((await shelfValue(ctx)) - value0, rupees(12000 - 4800), 'shelf value = Inventory');
  assert.equal(after.lines[0].quantityReturned, 4);
  assert.equal(after.returns.length, 1);
  assert.equal(after.returns[0].valuePaisa, rupees(4800));
  assert.equal(after.lines[0].returnable, 6, 'what is still free to go back');
});

test('more than is left on the line is refused and nothing changes', async () => {
  const ctx = await setup();
  const receipt = await tenMoreOfM(ctx);
  const line = receipt.lines[0];
  const entries0 = await JournalEntry.countDocuments();

  await assert.rejects(
    sendBack(ctx, await reload(receipt._id), [{ lineId: String(line._id), quantity: 11 }]),
    /Only 10 of Test Product \(M\) left to send back/
  );
  assert.equal((await variantOf(ctx, 'M')).stock, 20);
  assert.equal(await JournalEntry.countDocuments(), entries0);
});

test('only what is still on the shelf can go back — sold pieces can not', async () => {
  const ctx = await setup();
  const receipt = await receive(ctx, {
    lines: [
      { product: String(ctx.product._id), variantId: ctx.idOf('L'), quantity: 10, unitCost: 1000 }
    ]
  });
  const line = receipt.lines[0];
  // Eight sold since (an order would take them the same way).
  await Product.updateOne(
    { _id: ctx.product._id, 'variants._id': ctx.idOf('L') },
    { $inc: { 'variants.$.stock': -8, totalStock: -8 } }
  );
  const entries0 = await JournalEntry.countDocuments();

  await assert.rejects(
    sendBack(ctx, await reload(receipt._id), [{ lineId: String(line._id), quantity: 3 }]),
    /Only 2 of Test Product \(L\) left to send back/
  );
  assert.equal(await JournalEntry.countDocuments(), entries0, 'nothing was posted');
  assert.equal((await variantOf(ctx, 'L')).stock, 2);

  const detail = (await runHandler(getGoodsReceipt, { resource: await reload(receipt._id) })).body
    .data;
  assert.equal(detail.lines[0].inStock, 2);
  assert.equal(detail.lines[0].returnable, 2, 'the cap is the shelf, not the delivery');

  await sendBack(ctx, await reload(receipt._id), [{ lineId: String(line._id), quantity: 2 }]);
  assert.equal((await variantOf(ctx, 'L')).stock, 0);
  assert.equal((await variantOf(ctx, 'L')).costPrice, 0, 'no stock, no cost');
});

test('two send-backs racing for the last pieces: exactly one lands, the books agree', async () => {
  const ctx = await setup();
  const receipt = await receive(ctx, {
    lines: [
      {
        newProduct: {
          name: 'Racer',
          variants: [{ label: 'One', salePrice: 100, quantity: 10, unitCost: 1000 }]
        }
      }
    ]
  });
  const line = receipt.lines[0];

  const results = await Promise.allSettled([
    sendBack(ctx, await reload(receipt._id), [{ lineId: String(line._id), quantity: 6 }]),
    sendBack(ctx, await reload(receipt._id), [{ lineId: String(line._id), quantity: 6 }])
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);

  const racer = await Product.findById(line.product);
  assert.equal(racer.variants[0].stock, 4);
  const saved = await reload(receipt._id);
  assert.equal(saved.lines[0].quantityReturned, 6);
  assert.equal(saved.returns.length, 1);
  assert.equal(await owed(ctx), -rupees(4000), '10,000 billed − 6,000 sent back');
  assert.equal(await inventory(ctx), rupees(4000));
});

test('undo while untouched: stock, cost, Inventory and the supplier all go back', async () => {
  const ctx = await setup();
  const inv0 = await inventory(ctx);
  const value0 = await shelfValue(ctx);
  const receipt = await tenMoreOfM(ctx);

  const undone = (
    await runHandler(undoGoodsReceipt, { user: admin, resource: await reload(receipt._id) })
  ).body.data;
  assert.equal(undone.status, 'reversed');
  const m = await variantOf(ctx, 'M');
  assert.equal(m.stock, 10);
  assert.equal(m.costPrice, 1000);
  assert.equal(await inventory(ctx), inv0);
  assert.equal(await shelfValue(ctx), value0);
  assert.equal(await owed(ctx), 0);

  await assert.rejects(
    runHandler(undoGoodsReceipt, { user: admin, resource: await reload(receipt._id) }),
    /already undone/
  );
});

test('undoing a delivery that made an article leaves the article at zero stock', async () => {
  const ctx = await setup();
  const receipt = await receive(ctx, {
    lines: [
      {
        newProduct: {
          name: 'Gone Girl',
          variants: [{ label: 'M', salePrice: 100, quantity: 5, unitCost: 500 }]
        }
      }
    ]
  });
  await runHandler(undoGoodsReceipt, { user: admin, resource: await reload(receipt._id) });
  const article = await Product.findById(receipt.lines[0].product);
  assert.ok(article, 'the article stays');
  assert.equal(article.variants[0].stock, 0);
  assert.equal(article.totalStock, 0);
});

test('undo is refused after a send-back, and after any of it sold — and changes nothing', async () => {
  const ctx = await setup();
  const receipt = await tenMoreOfM(ctx);
  await sendBack(ctx, await reload(receipt._id), [
    { lineId: String(receipt.lines[0]._id), quantity: 1 }
  ]);
  await assert.rejects(
    runHandler(undoGoodsReceipt, { user: admin, resource: await reload(receipt._id) }),
    /already sent back/
  );

  const ctx2Receipt = await receive(ctx, {
    lines: [
      { product: String(ctx.product._id), variantId: ctx.idOf('L'), quantity: 5, unitCost: 700 }
    ]
  });
  await Product.updateOne(
    { _id: ctx.product._id, 'variants._id': ctx.idOf('L') },
    { $inc: { 'variants.$.stock': -1, totalStock: -1 } }
  );
  const entries0 = await JournalEntry.countDocuments();
  await assert.rejects(
    runHandler(undoGoodsReceipt, { user: admin, resource: await reload(ctx2Receipt._id) }),
    /already sold/
  );
  assert.equal((await reload(ctx2Receipt._id)).status, 'received', 'released again');
  assert.equal((await variantOf(ctx, 'L')).stock, 4);
  assert.equal(await JournalEntry.countDocuments(), entries0);
});

test('two undos at once: only one takes the stock back', async () => {
  const ctx = await setup();
  const receipt = await tenMoreOfM(ctx);
  const results = await Promise.allSettled([
    runHandler(undoGoodsReceipt, { user: admin, resource: await reload(receipt._id) }),
    runHandler(undoGoodsReceipt, { user: admin, resource: await reload(receipt._id) })
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await variantOf(ctx, 'M')).stock, 10, 'taken back once, not twice');
  assert.equal(await owed(ctx), 0);
});

test('a bad delivery is refused before anything is written', async () => {
  const ctx = await setup();
  const line = {
    product: String(ctx.product._id),
    variantId: ctx.idOf('M'),
    quantity: 1,
    unitCost: 100
  };
  const entries0 = await JournalEntry.countDocuments();

  await assert.rejects(
    receive(ctx, { lines: [line], paidNow: 101, method: 'cash' }),
    /pay more now/
  );

  const employee = await makeParty(ctx.biz._id, 'employee', { name: 'Not a supplier' });
  await assert.rejects(
    receive({ ...ctx, supplier: employee }, { lines: [line] }),
    /Choose a supplier/
  );

  const other = await makeBusiness({ name: 'Other Biz' });
  const theirs = await makeParty(other._id, 'supplier', { name: 'Theirs' });
  await assert.rejects(
    receive({ ...ctx, supplier: theirs }, { lines: [line] }),
    /Choose a supplier/
  );

  const foreign = await makeProduct(other._id);
  await assert.rejects(
    receive(ctx, {
      lines: [{ ...line, product: String(foreign._id), variantId: String(foreign.variants[0]._id) }]
    }),
    /not in this business/
  );
  await assert.rejects(
    receive(ctx, { lines: [{ ...line, variantId: String(oid()) }] }),
    /not in this business/
  );

  assert.equal(await JournalEntry.countDocuments(), entries0);
  assert.equal(await GoodsReceipt.countDocuments(), 0);
  assert.equal((await variantOf(ctx, 'M')).stock, 10);
});

test('the request shape: lines, whole pieces, and no negative cost', () => {
  const base = { business: 'b', party: 'p' };
  const ok = line => goodsReceiptCreateSchema.safeParse({ ...base, lines: [line] }).success;
  const line = { product: 'x', variantId: 'v', quantity: 1, unitCost: 10 };
  assert.equal(ok(line), true);
  assert.equal(ok({ ...line, quantity: 0 }), false);
  assert.equal(ok({ ...line, quantity: 1.5 }), false);
  assert.equal(ok({ ...line, unitCost: -1 }), false);
  assert.equal(goodsReceiptCreateSchema.safeParse({ ...base, lines: [] }).success, false);
  assert.equal(
    ok({ newProduct: { name: 'A', variants: [] } }),
    false,
    'a new article needs a size'
  );
  assert.equal(
    goodsReceiptReturnSchema.safeParse({
      lines: [
        { lineId: 'a', quantity: 1 },
        { lineId: 'a', quantity: 1 }
      ]
    }).success,
    false,
    'a line listed twice'
  );
});

test('a locked period refuses before any stock moves', async () => {
  const ctx = await setup();
  await PeriodLock.create({
    business: ctx.biz._id,
    periodEnd: new Date(Date.now() + 86_400_000),
    lockedBy: userId
  });
  await assert.rejects(tenMoreOfM(ctx), /locked/);
  assert.equal((await variantOf(ctx, 'M')).stock, 10);
  assert.equal(await GoodsReceipt.countDocuments(), 0);
});

test('Khata refuses to reverse a delivery’s entry and says where to undo it', async () => {
  const ctx = await setup();
  const receipt = await tenMoreOfM(ctx);
  await assert.rejects(
    runHandler(reversePartyEntry, {
      user: admin,
      resource: ctx.supplier,
      params: { entryId: String(receipt.receiveEntry) }
    }),
    /Undo this on the goods receipt/
  );
});

test('without "See costs", every money figure is stripped from a receipt', async () => {
  const ctx = await setup();
  const receipt = await tenMoreOfM(ctx, { paidNow: 4000, method: 'cash' });
  const detail = (await runHandler(getGoodsReceipt, { resource: await reload(receipt._id) })).body
    .data;

  const user = { role: { fullAccess: false, permissions: [] }, permissionOverrides: [] };
  const seen = await new Promise(resolve => {
    const res = { json: body => resolve(body) };
    hideCosts({ user }, res, () => res.json({ success: true, data: detail }));
  });
  const text = JSON.stringify(seen);
  for (const key of ['unitCostPaisa', 'totalCostPaisa', 'paidNowPaisa', 'valuePaisa']) {
    assert.equal(text.includes(key), false, `${key} must not leak`);
  }
  assert.equal(seen.data.lines[0].quantity, 10, 'quantities still show');
});
