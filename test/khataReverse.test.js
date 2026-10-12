import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  connect,
  clear,
  disconnect,
  makeBusiness,
  makeParty,
  runHandler,
  oid,
  userId
} from './helpers/db.js';
import Order from '../models/Order.js';
import Material from '../models/Material.js';
import JournalEntry from '../models/JournalEntry.js';
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { accountBalance, partyBalance } from '../utils/ledger.js';
import {
  recordPartyTransaction,
  recordPartyOpeningBalance,
  reversePartyEntry,
  getPartyStatement
} from '../controllers/partyController.js';
import { buyMaterial } from '../controllers/materialController.js';
import { partyTransactionSchema, partyOpeningSchema } from '../schemas/parties.js';
import { materialPurchaseSchema } from '../schemas/materials.js';
import { toPaisa } from '../utils/money.js';

/**
 * Reversing from a person's Khata: only what the Khata created (a payment, bill,
 * salary, loan or opening balance), never an order, invoice or material entry.
 * The original stays in the history; a matching reversal brings the balance back.
 */

before(connect);
after(disconnect);
afterEach(clear);

const txn = (party, body) =>
  runHandler(recordPartyTransaction, { resource: party, body: partyTransactionSchema.parse(body) });
const reverse = (party, entryId) =>
  runHandler(reversePartyEntry, { resource: party, params: { entryId: String(entryId) } });
const rows = async party =>
  (await runHandler(getPartyStatement, { resource: party })).body.data.rows;
const cash = async biz => accountBalance(biz._id, (await accountByCode(biz._id, CODES.CASH))._id);

test('a supplier payment is reversed: balance and cash come back', async () => {
  const biz = await makeBusiness();
  const supplier = await makeParty(biz._id, 'supplier');
  const paid = await txn(supplier, { direction: 'gave', amount: 5000 });
  assert.equal(await partyBalance(biz._id, supplier._id), toPaisa(5000));
  assert.equal(await cash(biz), -toPaisa(5000));

  await reverse(supplier, paid.body.data._id);
  assert.equal(await partyBalance(biz._id, supplier._id), 0);
  assert.equal(await cash(biz), 0);
});

test('the statement marks the original reversed and the reversal as one', async () => {
  const biz = await makeBusiness();
  const supplier = await makeParty(biz._id, 'supplier');
  const paid = await txn(supplier, { direction: 'gave', amount: 5000 });
  const before = (await rows(supplier))[0];
  assert.equal(before.canReverse, true);

  await reverse(supplier, paid.body.data._id);
  const [original, reversal] = await rows(supplier);
  assert.equal(original.reversed, true);
  assert.equal(original.canReverse, false);
  assert.equal(reversal.isReversal, true);
  assert.equal(reversal.canReverse, false);
});

test('the same entry can not be reversed twice', async () => {
  const biz = await makeBusiness();
  const supplier = await makeParty(biz._id, 'supplier');
  const paid = await txn(supplier, { direction: 'gave', amount: 5000 });
  await reverse(supplier, paid.body.data._id);
  await assert.rejects(reverse(supplier, paid.body.data._id), /already been reversed/);
});

test('reversing a credit customer’s payment makes their counter sale unpaid again', async () => {
  const biz = await makeBusiness();
  const customer = await makeParty(biz._id, 'customer');
  const sale = await Order.create({
    business: biz._id,
    customer: oid(),
    customerParty: customer._id,
    source: 'walk-in',
    customerName: 'Ali',
    contactNumber: '03001234567',
    items: [
      {
        product: oid(),
        variantId: oid(),
        productName: 'Kurta',
        quantity: 1,
        unitPrice: 3000,
        unitCost: 0
      }
    ],
    status: 'delivered',
    createdBy: userId
  });

  const paid = await txn(customer, { direction: 'got', amount: 3000 });
  assert.equal((await Order.findById(sale._id)).paymentStatus, 'paid');

  await reverse(customer, paid.body.data._id);
  const after = await Order.findById(sale._id);
  assert.equal(after.paymentStatus, 'unpaid');
  assert.equal(after.paidPaisa, 0);
});

test('a material purchase can not be reversed from the supplier’s Khata', async () => {
  const biz = await makeBusiness();
  const supplier = await makeParty(biz._id, 'supplier');
  const material = await Material.create({
    business: biz._id,
    name: 'Lace',
    unit: 'metre',
    createdBy: userId
  });
  const bought = await runHandler(buyMaterial, {
    resource: material,
    body: materialPurchaseSchema.parse({
      quantity: 10,
      amount: 1000,
      onCredit: true,
      party: String(supplier._id)
    })
  });
  const entry = await JournalEntry.findById(bought.body.data.entry);
  await assert.rejects(reverse(supplier, entry._id), /on the material/);
});

test('an opening balance can be reversed', async () => {
  const biz = await makeBusiness();
  const supplier = await makeParty(biz._id, 'supplier');
  const out = await runHandler(recordPartyOpeningBalance, {
    resource: supplier,
    body: partyOpeningSchema.parse({ owesUs: false, amount: 40000 })
  });
  assert.equal(await partyBalance(biz._id, supplier._id), -toPaisa(40000));

  await reverse(supplier, out.body.data._id);
  assert.equal(await partyBalance(biz._id, supplier._id), 0);
});

test('a loan taken can not be reversed while part of it is repaid', async () => {
  const biz = await makeBusiness();
  const lender = await makeParty(biz._id, 'lender');
  const taken = await txn(lender, { direction: 'got', amount: 100000 });
  const repaid = await txn(lender, { direction: 'gave', amount: 30000 });

  await assert.rejects(reverse(lender, taken.body.data._id), /already repaid/);
  await reverse(lender, repaid.body.data._id);
  await reverse(lender, taken.body.data._id);
  assert.equal(await partyBalance(biz._id, lender._id), 0);
});

test('an entry that belongs to another person is not found', async () => {
  const biz = await makeBusiness();
  const a = await makeParty(biz._id, 'supplier');
  const b = await makeParty(biz._id, 'supplier');
  const paid = await txn(a, { direction: 'gave', amount: 1000 });
  await assert.rejects(reverse(b, paid.body.data._id), /not found/);
});
