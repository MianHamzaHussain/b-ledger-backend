import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, makeBusiness, makeParty, oid, userId } from './helpers/db.js';
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { postOrderSale, computeRemittance } from '../utils/orderPosting.js';
import { toPaisa } from '../utils/money.js';

before(connect);
after(disconnect);
afterEach(clear);

const sumDebit = e => e.lines.reduce((s, l) => s + (l.debitPaisa || 0), 0);
const sumCredit = e => e.lines.reduce((s, l) => s + (l.creditPaisa || 0), 0);

test('computeRemittance splits COD into delivery, taxes and the net', () => {
  // COD 1000, delivery 100, WHT 2%, sales tax 2% → net 1000−100−20−20 = 860.
  const parts = computeRemittance(toPaisa(1000), toPaisa(100), {
    whtPercent: 2,
    salesTaxPercent: 2
  });
  assert.equal(parts.deliveryPaisa, toPaisa(100));
  assert.equal(parts.whtPaisa, toPaisa(20));
  assert.equal(parts.salesTaxPaisa, toPaisa(20));
  assert.equal(parts.bankPaisa, toPaisa(860));
});

test('a courier order books COD to the courier at NET, and balances', async () => {
  const biz = await makeBusiness({
    codTax: { whtPercent: 2, salesTaxPercent: 2, registered: false }
  });
  const courier = await makeParty(biz._id, 'courier');
  const order = {
    _id: oid(),
    business: biz._id,
    orderNumber: '0001',
    total: 1000,
    codAmount: 1000,
    advanceAmount: 0,
    courier: courier._id,
    deliveryChargePaisa: toPaisa(100),
    items: [{ unitCost: 400, quantity: 1 }]
  };

  const entry = await postOrderSale(order, userId);
  assert.equal(sumDebit(entry), sumCredit(entry), 'entry balances');

  const codAcc = (await accountByCode(biz._id, CODES.COD_RECEIVABLE))._id;
  const codLine = entry.lines.find(l => String(l.account) === String(codAcc));
  assert.equal(String(codLine.party), String(courier._id), 'COD tagged to the courier');
  assert.equal(codLine.debitPaisa, toPaisa(860), 'courier owes the NET, not the gross COD');
});

test('a walk-in books the full balance to the customer — no courier taxes', async () => {
  const biz = await makeBusiness({ codTax: { whtPercent: 2, salesTaxPercent: 2 } });
  const customer = await makeParty(biz._id, 'customer');
  const order = {
    _id: oid(),
    business: biz._id,
    orderNumber: '0002',
    total: 1000,
    codAmount: 1000,
    advanceAmount: 0,
    courier: undefined,
    customerParty: customer._id,
    items: [{ unitCost: 400, quantity: 1 }]
  };

  const entry = await postOrderSale(order, userId);
  assert.equal(sumDebit(entry), sumCredit(entry), 'entry balances');

  const arAcc = (await accountByCode(biz._id, CODES.ACCOUNTS_RECEIVABLE))._id;
  const arLine = entry.lines.find(l => String(l.account) === String(arAcc));
  assert.equal(String(arLine.party), String(customer._id), 'balance owed by the customer');
  assert.equal(arLine.debitPaisa, toPaisa(1000), 'full amount, nothing withheld');

  // No courier deduction accounts should appear on a walk-in.
  const delivery = (await accountByCode(biz._id, CODES.DELIVERY_CHARGES))._id;
  const wht = (await accountByCode(biz._id, CODES.WITHHOLDING_TAX))._id;
  const touched = new Set(entry.lines.map(l => String(l.account)));
  assert.ok(!touched.has(String(delivery)), 'no delivery charge');
  assert.ok(!touched.has(String(wht)), 'no withholding tax');
});
