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
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { accountBalance, partyBalance } from '../utils/ledger.js';
import { recordPartyTransaction, getPartySummary } from '../controllers/partyController.js';
import { updateOrderPayment } from '../controllers/orderController.js';
import { partyTransactionSchema } from '../schemas/parties.js';
import { toPaisa } from '../utils/money.js';

/**
 * "You gave" / "You got" on a party posts a balanced entry to the account its
 * type implies — the user never picks one, and profit stays right.
 */

before(connect);
after(disconnect);
afterEach(clear);

const txn = (party, body) =>
  runHandler(recordPartyTransaction, { resource: party, body: partyTransactionSchema.parse(body) });

const balanceOf = async (biz, code) =>
  accountBalance(biz._id, (await accountByCode(biz._id, code))._id);

test('supplier: a bill needs a category and becomes an expense owed to them', async () => {
  const biz = await makeBusiness();
  const supplier = await makeParty(biz._id, 'supplier');

  await assert.rejects(txn(supplier, { direction: 'got', amount: 5000 }), /what this bill/);

  await txn(supplier, { direction: 'got', amount: 5000, category: CODES.PACKING });
  assert.equal(await balanceOf(biz, CODES.PACKING), toPaisa(5000), 'expensed');
  assert.equal(await partyBalance(biz._id, supplier._id), -toPaisa(5000), 'we owe them');

  await txn(supplier, { direction: 'gave', amount: 2000, method: 'bank' });
  assert.equal(await partyBalance(biz._id, supplier._id), -toPaisa(3000));
  assert.equal(await balanceOf(biz, CODES.BANK), -toPaisa(2000));
});

test('supplier: a bill can not be booked to a non-expense account', async () => {
  const biz = await makeBusiness();
  const supplier = await makeParty(biz._id, 'supplier');
  await assert.rejects(
    txn(supplier, { direction: 'got', amount: 100, category: CODES.CASH }),
    /not an expense/
  );
});

test('reseller: money got reduces what they owe, money gave adds to it', async () => {
  const biz = await makeBusiness();
  const reseller = await makeParty(biz._id, 'reseller');

  await txn(reseller, { direction: 'gave', amount: 1000 });
  await txn(reseller, { direction: 'got', amount: 400 });
  assert.equal(await partyBalance(biz._id, reseller._id), toPaisa(600), 'still owes 600');
  assert.equal(await balanceOf(biz, CODES.CASH), -toPaisa(600));
});

test('employee: gave clears owed salary first; got records salary due', async () => {
  const biz = await makeBusiness();
  const employee = await makeParty(biz._id, 'employee');

  await txn(employee, { direction: 'got', amount: 25000 });
  await txn(employee, { direction: 'gave', amount: 25000 });
  assert.equal(await partyBalance(biz._id, employee._id), 0);
  assert.equal(await balanceOf(biz, CODES.SALARIES), toPaisa(25000), 'salary booked once');
});

test('lender: loan in, and a repayment can not exceed what is owed', async () => {
  const biz = await makeBusiness();
  const lender = await makeParty(biz._id, 'lender');

  await txn(lender, { direction: 'got', amount: 100000 });
  await assert.rejects(txn(lender, { direction: 'gave', amount: 150000 }), /more than/);
  await txn(lender, { direction: 'gave', amount: 40000 });
  assert.equal(await partyBalance(biz._id, lender._id), -toPaisa(60000));
});

test('courier: we never hand a courier money from here', async () => {
  const biz = await makeBusiness();
  const courier = await makeParty(biz._id, 'courier');
  await assert.rejects(txn(courier, { direction: 'gave', amount: 100 }), /only pays you/);
});

/** A delivered, unpaid counter sale owing `owed` rupees to `customer`. */
const counterSale = (biz, customer, owed) =>
  Order.create({
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
        unitPrice: owed,
        unitCost: 0
      }
    ],
    status: 'delivered',
    createdBy: userId
  });

test('customer: a part-payment lands on the oldest counter sale first', async () => {
  const biz = await makeBusiness();
  const customer = await makeParty(biz._id, 'customer');
  const first = await counterSale(biz, customer, 3000);
  const second = await counterSale(biz, customer, 2000);

  await txn(customer, { direction: 'got', amount: 4000 });

  const a = await Order.findById(first._id);
  const b = await Order.findById(second._id);
  assert.equal(a.paymentStatus, 'paid', 'oldest fully covered');
  assert.equal(b.paymentStatus, 'unpaid');
  assert.equal(b.paidPaisa, toPaisa(1000), '1,000 applied to the next');
});

test('customer: Mark paid after a part-payment books only what is still owed', async () => {
  const biz = await makeBusiness();
  const customer = await makeParty(biz._id, 'customer');
  // Book the sale's receivable the way delivery would, so balances are real.
  await txn(customer, { direction: 'gave', amount: 5000 });
  const order = await counterSale(biz, customer, 5000);

  await txn(customer, { direction: 'got', amount: 2000 });
  await runHandler(updateOrderPayment, {
    resource: await Order.findById(order._id),
    body: { paymentStatus: 'paid' }
  });

  assert.equal(await partyBalance(biz._id, customer._id), 0, 'settled, not overpaid');
  assert.equal(await balanceOf(biz, CODES.CASH), 0, '5,000 out, 2,000 + 3,000 in');

  // Undoing it from the order only unwinds the 3,000 that button booked.
  await runHandler(updateOrderPayment, {
    resource: await Order.findById(order._id),
    body: { paymentStatus: 'unpaid' }
  });
  const after = await Order.findById(order._id);
  assert.equal(after.paidPaisa, toPaisa(2000));
});

test('customer: an order paid from their account can not be marked unpaid', async () => {
  const biz = await makeBusiness();
  const customer = await makeParty(biz._id, 'customer');
  const order = await counterSale(biz, customer, 1000);
  await txn(customer, { direction: 'got', amount: 1000 });

  await assert.rejects(
    runHandler(updateOrderPayment, {
      resource: await Order.findById(order._id),
      body: { paymentStatus: 'unpaid' }
    }),
    /refund on their page/
  );
});

test('summary totals what is owed each way across all parties', async () => {
  const biz = await makeBusiness();
  const reseller = await makeParty(biz._id, 'reseller');
  const supplier = await makeParty(biz._id, 'supplier');
  await txn(reseller, { direction: 'gave', amount: 700 });
  await txn(supplier, { direction: 'got', amount: 300, category: CODES.RENT });

  const out = await runHandler(getPartySummary, {
    query: { business: String(biz._id) },
    accessFilter: {}
  });
  assert.equal(out.body.data.receivable, 700);
  assert.equal(out.body.data.payable, 300);
});

test('summary is 404 for a business outside your scope', async () => {
  const biz = await makeBusiness();
  await assert.rejects(
    runHandler(getPartySummary, {
      query: { business: String(biz._id) },
      accessFilter: { business: { $in: [oid()] } }
    }),
    /not found/
  );
});

test('employee advance: not an expense, and they owe it back', async () => {
  const biz = await makeBusiness();
  const employee = await makeParty(biz._id, 'employee');

  await txn(employee, { direction: 'gave', amount: 5000, purpose: 'advance' });
  assert.equal(await balanceOf(biz, CODES.SALARIES), 0, 'no salary expense yet');
  assert.equal(await partyBalance(biz._id, employee._id), toPaisa(5000), 'they hold 5,000 of ours');
});

test('employee advance: salary due nets it off, so you pay only the rest', async () => {
  const biz = await makeBusiness();
  const employee = await makeParty(biz._id, 'employee');

  await txn(employee, { direction: 'gave', amount: 5000, purpose: 'advance' });
  await txn(employee, { direction: 'got', amount: 30000 }); // salary due
  assert.equal(await partyBalance(biz._id, employee._id), -toPaisa(25000), 'owed 25,000');

  await txn(employee, { direction: 'gave', amount: 25000 });
  assert.equal(await partyBalance(biz._id, employee._id), 0);
  assert.equal(await balanceOf(biz, CODES.SALARIES), toPaisa(30000), 'full salary expensed');
  assert.equal(await balanceOf(biz, CODES.CASH), -toPaisa(30000), '5,000 + 25,000 paid out');
});

test('employee advance: cut straight from a salary payment', async () => {
  const biz = await makeBusiness();
  const employee = await makeParty(biz._id, 'employee');

  await txn(employee, { direction: 'gave', amount: 5000, purpose: 'advance' });
  await assert.rejects(
    txn(employee, { direction: 'gave', amount: 25000, deductAdvance: 6000 }),
    /Only Rs 5000 of advance/
  );

  await txn(employee, { direction: 'gave', amount: 25000, deductAdvance: 5000 });
  assert.equal(await partyBalance(biz._id, employee._id), 0, 'advance used up');
  assert.equal(await balanceOf(biz, CODES.SALARIES), toPaisa(30000), 'salary = cash + advance cut');
});
