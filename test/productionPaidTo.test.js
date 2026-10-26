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
  userId
} from './helpers/db.js';
import ProductionBatch from '../models/ProductionBatch.js';
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { accountBalance, partyStatement } from '../utils/ledger.js';
import { createBatch, closeBatch } from '../controllers/productionController.js';

/**
 * A cost paid from Cash or a bank says WHO it was paid to, so the supplier's Khata answers "what did we
 * pay them?". The bill and the payment both show there, and the balance ends where it began.
 */
before(connect);
after(disconnect);
afterEach(clear);

const admin = { id: userId, role: { fullAccess: true } };
const balance = async (biz, code) =>
  accountBalance(biz._id, (await accountByCode(biz._id, code))._id);

const setup = async () => {
  const biz = await makeBusiness();
  const product = await makeProduct(biz._id, [
    { label: 'M', costPrice: 0, salePrice: 2000, stock: 0 }
  ]);
  const supplier = await makeParty(biz._id, 'supplier', { name: 'Master Tailor' });
  return { biz, product, supplier, variantId: String(product.variants[0]._id) };
};

const make = (ctx, costLines) =>
  runHandler(createBatch, {
    user: admin,
    body: {
      business: String(ctx.biz._id),
      product: String(ctx.product._id),
      lines: [{ variantId: ctx.variantId, quantity: 10, costLines }]
    }
  });

const close = async id =>
  runHandler(closeBatch, { resource: await ProductionBatch.findById(id), body: {} });

test('a paid cost without a supplier is refused, naming the cost', async () => {
  const ctx = await setup();
  await assert.rejects(
    make(ctx, [{ label: 'Tailor', amount: 3000, fund: 'cash' }]),
    /Choose who you paid for "Tailor"/
  );
});

test('paid to a supplier: both rows show in their Khata, the balance stays zero, cash goes down', async () => {
  const ctx = await setup();
  const out = await make(ctx, [
    { label: 'Tailor', amount: 3000, fund: 'cash', paidTo: String(ctx.supplier._id) }
  ]);
  await close(out.body.data._id);

  const { rows, balancePaisa } = await partyStatement(ctx.biz._id, ctx.supplier._id);
  assert.equal(rows.length, 2, 'the bill and the payment');
  assert.equal(balancePaisa, 0, 'nothing is left owing');
  assert.equal(await balance(ctx.biz, CODES.CASH), -300000, 'cash paid out');
  assert.equal(await balance(ctx.biz, CODES.INVENTORY), 300000, 'the article carries the cost');
  assert.equal(await balance(ctx.biz, CODES.ACCOUNTS_PAYABLE), 0);
});

test('a bank-paid cost is paid from the bank and still lands in the supplier’s Khata', async () => {
  const ctx = await setup();
  const out = await make(ctx, [
    { label: 'Cloth', amount: 5000, fund: 'bank', paidTo: String(ctx.supplier._id) }
  ]);
  await close(out.body.data._id);
  assert.equal(await balance(ctx.biz, CODES.BANK), -500000);
  assert.equal((await partyStatement(ctx.biz._id, ctx.supplier._id)).rows.length, 2);
});

test('on credit is unchanged: the supplier is owed, nothing is paid', async () => {
  const ctx = await setup();
  const out = await make(ctx, [{ label: 'Cloth', amount: 4000, fund: String(ctx.supplier._id) }]);
  await close(out.body.data._id);
  const { rows, balancePaisa } = await partyStatement(ctx.biz._id, ctx.supplier._id);
  assert.equal(rows.length, 1);
  assert.equal(balancePaisa, -400000, 'we owe them');
  assert.equal(await balance(ctx.biz, CODES.CASH), 0);
});

test('paid and on-credit costs to one supplier add up correctly', async () => {
  const ctx = await setup();
  const id = String(ctx.supplier._id);
  const out = await make(ctx, [
    { label: 'Tailor', amount: 3000, fund: 'cash', paidTo: id },
    { label: 'Cloth', amount: 4000, fund: id }
  ]);
  await close(out.body.data._id);
  assert.equal((await partyStatement(ctx.biz._id, ctx.supplier._id)).balancePaisa, -400000);
  assert.equal(await balance(ctx.biz, CODES.CASH), -300000);
  assert.equal(await balance(ctx.biz, CODES.INVENTORY), 700000);
});

test('the supplier must belong to this business', async () => {
  const ctx = await setup();
  const other = await makeBusiness({ name: 'Other' });
  const stranger = await makeParty(other._id, 'supplier');
  await assert.rejects(
    make(ctx, [{ label: 'Tailor', amount: 3000, fund: 'cash', paidTo: String(stranger._id) }]),
    /not a party of this business/
  );
});

test('opening stock needs no supplier and moves no money', async () => {
  const ctx = await setup();
  const out = await make(ctx, [{ label: 'Opening stock', amount: 9000, fund: 'opening' }]);
  await close(out.body.data._id);
  assert.equal(await balance(ctx.biz, CODES.CASH), 0);
  assert.equal(await balance(ctx.biz, CODES.INVENTORY), 900000);
});

test('an older draft with an unnamed paid cost can not close until it is named', async () => {
  const ctx = await setup();
  // As saved before this rule: a paid cost with no one to pay.
  const draft = await ProductionBatch.create({
    business: ctx.biz._id,
    product: ctx.product._id,
    lines: [
      {
        variantId: ctx.product.variants[0]._id,
        variantLabel: 'M',
        quantity: 10,
        costLines: [{ label: 'Tailor', amountPaisa: 300000, method: 'cash', onCredit: false }]
      }
    ],
    createdBy: userId
  });
  await assert.rejects(close(draft._id), /Choose who you paid for "Tailor"/);
});
