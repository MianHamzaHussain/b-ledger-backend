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
  getReceiptSuppliers,
  returnGoods,
  updateGoodsReceiptNote,
  undoGoodsReceipt
} from '../controllers/goodsReceiptController.js';
import { reversePartyEntry } from '../controllers/partyController.js';
import {
  goodsReceiptCreateSchema,
  goodsReceiptNoteSchema,
  goodsReceiptReturnSchema
} from '../schemas/goodsReceipts.js';

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

test('editing the note changes the note only — stock, money and status stay put', async () => {
  const ctx = await setup();
  const receipt = await tenMoreOfM(ctx, { note: 'ABHI LENA HN' });
  const inv0 = await inventory(ctx);
  const owed0 = await owed(ctx);
  const stock0 = (await variantOf(ctx, 'M')).stock;

  const body = (
    await runHandler(updateGoodsReceiptNote, {
      user: admin,
      resource: await reload(receipt._id),
      body: { note: 'Lene hain — Monday ko' }
    })
  ).body.data;

  assert.equal(body.note, 'Lene hain — Monday ko');
  assert.equal(body.status, receipt.status);
  assert.equal(body.totalCostPaisa, receipt.totalCostPaisa);
  assert.equal(String(body.updatedBy), String(userId));
  assert.equal(await inventory(ctx), inv0);
  assert.equal(await owed(ctx), owed0);
  assert.equal((await variantOf(ctx, 'M')).stock, stock0);
  assert.equal((await reload(receipt._id)).note, 'Lene hain — Monday ko');
});

test('an empty note clears it, and a note over 200 characters is refused', async () => {
  const ctx = await setup();
  const receipt = await tenMoreOfM(ctx, { note: 'old' });
  const cleared = (
    await runHandler(updateGoodsReceiptNote, {
      user: admin,
      resource: await reload(receipt._id),
      body: { note: '' }
    })
  ).body.data;
  assert.ok(!cleared.note);

  assert.equal(goodsReceiptNoteSchema.safeParse({ note: '' }).success, true);
  assert.equal(goodsReceiptNoteSchema.safeParse({ note: 'x'.repeat(200) }).success, true);
  assert.equal(goodsReceiptNoteSchema.safeParse({ note: 'x'.repeat(201) }).success, false);
  assert.equal(goodsReceiptNoteSchema.safeParse({}).success, false, 'a note must be sent');
});

test('a note edit racing an undo does not break either, and the books still agree', async () => {
  const ctx = await setup();
  const receipt = await tenMoreOfM(ctx);
  const results = await Promise.allSettled([
    runHandler(updateGoodsReceiptNote, {
      user: admin,
      resource: await reload(receipt._id),
      body: { note: 'edited' }
    }),
    runHandler(undoGoodsReceipt, { user: admin, resource: await reload(receipt._id) })
  ]);
  assert.deepEqual(
    results.map(r => r.status),
    ['fulfilled', 'fulfilled']
  );
  const after = await reload(receipt._id);
  assert.equal(after.status, 'reversed');
  assert.equal(after.note, 'edited');
  assert.equal((await variantOf(ctx, 'M')).stock, 10);
  assert.equal(await owed(ctx), 0);
});

// ── The suppliers list (R9-2): one row per supplier, newest delivery first ─────────────────────

const suppliersOf = (ctx, query = {}, extra = {}) =>
  runHandler(getReceiptSuppliers, {
    user: admin,
    query: { business: String(ctx.biz._id), ...query },
    accessFilter: { business: { $in: [ctx.biz._id] } },
    ...extra
  }).then(r => r.body);

const deliverTo = async (ctx, supplier, date, quantity = 3) => {
  const receipt = await runHandler(createGoodsReceipt, {
    user: admin,
    body: goodsReceiptCreateSchema.parse({
      business: String(ctx.biz._id),
      party: String(supplier._id),
      date,
      lines: [
        { product: String(ctx.product._id), variantId: ctx.idOf('M'), quantity, unitCost: 1000 }
      ]
    })
  }).then(r => r.body.data);
  return receipt;
};

test('the suppliers list has one row per supplier, newest delivery first, with counts', async () => {
  const ctx = await setup();
  const second = await makeParty(ctx.biz._id, 'supplier', { name: 'Noor Textiles' });
  await deliverTo(ctx, ctx.supplier, '2026-10-01');
  await deliverTo(ctx, ctx.supplier, '2026-10-20', 4);
  await deliverTo(ctx, second, '2026-10-25', 2);

  const { data, total } = await suppliersOf(ctx);
  assert.equal(total, 2, 'two suppliers, not three deliveries');
  assert.deepEqual(
    data.map(r => r.name),
    ['Noor Textiles', 'Bilal Fabrics'],
    'the supplier delivered from most recently comes first'
  );
  const bilal = data[1];
  assert.equal(bilal.deliveries, 2);
  assert.equal(bilal.pieces, 7);
  assert.equal(bilal.sentBackPieces, 0);
  assert.equal(new Date(bilal.lastDeliveryAt).toISOString().slice(0, 10), '2026-10-20');
});

test('pieces sent back are counted, and a reversed delivery is not a delivery', async () => {
  const ctx = await setup();
  const kept = await deliverTo(ctx, ctx.supplier, '2026-10-10', 5);
  await sendBack(ctx, await reload(kept._id), [{ lineId: String(kept.lines[0]._id), quantity: 2 }]);
  const mistaken = await deliverTo(ctx, ctx.supplier, '2026-10-12', 3);
  await runHandler(undoGoodsReceipt, { user: admin, resource: await reload(mistaken._id) });

  const { data } = await suppliersOf(ctx);
  assert.equal(data[0].deliveries, 1, 'the undone delivery is not counted');
  assert.equal(data[0].pieces, 5);
  assert.equal(data[0].sentBackPieces, 2);
});

test('the suppliers list pages five at a time and searches the name literally', async () => {
  const ctx = await setup();
  for (let i = 0; i < 7; i += 1) {
    const supplier = await makeParty(ctx.biz._id, 'supplier', { name: `Mill ${i}` });
    await deliverTo(ctx, supplier, `2026-10-${String(10 + i).padStart(2, '0')}`, 1);
  }
  const first = await suppliersOf(ctx);
  assert.equal(first.count, 5);
  assert.equal(first.total, 7);
  assert.deepEqual(first.pagination.next, { page: 2, limit: 5 });
  assert.equal((await suppliersOf(ctx, { page: '2' })).count, 2);

  assert.equal((await suppliersOf(ctx, { search: 'mill 3' })).data[0].name, 'Mill 3');
  assert.equal(
    (await suppliersOf(ctx, { search: '.*' })).total,
    0,
    'a pattern is text, not a pattern'
  );
});

test('another business is never in the list, and outside your scope is a 404', async () => {
  const ctx = await setup();
  const otherBiz = await makeBusiness({ name: 'Other Biz' });
  const otherSupplier = await makeParty(otherBiz._id, 'supplier', { name: 'Secret Mill' });
  const otherProduct = await makeProduct(otherBiz._id, [
    { label: 'M', costPrice: 1000, salePrice: 2000, stock: 0 }
  ]);
  await runHandler(createGoodsReceipt, {
    user: admin,
    body: goodsReceiptCreateSchema.parse({
      business: String(otherBiz._id),
      party: String(otherSupplier._id),
      lines: [
        {
          product: String(otherProduct._id),
          variantId: String(otherProduct.variants[0]._id),
          quantity: 2,
          unitCost: 1000
        }
      ]
    })
  });

  assert.equal((await suppliersOf(ctx)).total, 0, 'the other business delivery is not ours');
  await assert.rejects(
    suppliersOf(ctx, { business: String(otherBiz._id) }),
    err => err.statusCode === 404
  );
});

test('what was delivered in total is a cost: it vanishes without See costs, the rest stays', async () => {
  const ctx = await setup();
  await deliverTo(ctx, ctx.supplier, '2026-10-01', 3);

  const reply = await new Promise((resolve, reject) => {
    const res = { json: body => resolve(body) };
    const user = { role: { fullAccess: false, permissions: [] }, permissionOverrides: [] };
    hideCosts({ user }, res, () => {});
    getReceiptSuppliers(
      {
        user,
        query: { business: String(ctx.biz._id) },
        accessFilter: { business: { $in: [ctx.biz._id] } }
      },
      { status: () => res, json: res.json },
      reject
    );
  });
  assert.equal(reply.data[0].totalCostPaisa, undefined);
  assert.equal(reply.data[0].deliveries, 1);
  assert.equal(reply.data[0].name, 'Bilal Fabrics');
});
