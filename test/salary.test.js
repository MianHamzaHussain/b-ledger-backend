import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, makeBusiness, makeParty, runHandler } from './helpers/db.js';
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { accountBalance, partyBalance } from '../utils/ledger.js';
import { recordSalary } from '../controllers/financeController.js';
import { toPaisa } from '../utils/money.js';

/**
 * Salary is booked once. Paying an employee clears what an earlier accrual left
 * owed before any new expense — so "record as owed" then "paid" neither leaves
 * them owed forever nor counts the salary twice.
 */

before(connect);
after(disconnect);
afterEach(clear);

async function setup() {
  const biz = await makeBusiness();
  const employee = await makeParty(biz._id, 'employee');
  const acc = async code => (await accountByCode(biz._id, code))._id;
  const salary = body => runHandler(recordSalary, { body: { business: String(biz._id), ...body } });
  const balances = async () => ({
    expense: await accountBalance(biz._id, await acc(CODES.SALARIES)),
    cash: await accountBalance(biz._id, await acc(CODES.CASH)),
    // Negative = we owe the employee.
    employee: await partyBalance(biz._id, employee._id)
  });
  return { biz, employee: String(employee._id), salary, balances };
}

test('accrue then pay books the salary once and clears the employee', async () => {
  const { employee, salary, balances } = await setup();

  await salary({ amount: 30000, party: employee, onCredit: true });
  assert.equal((await balances()).employee, -toPaisa(30000), 'owed after accrual');

  await salary({ amount: 30000, party: employee, method: 'cash' });
  const b = await balances();
  assert.equal(b.expense, toPaisa(30000), 'expensed once, not twice');
  assert.equal(b.cash, -toPaisa(30000));
  assert.equal(b.employee, 0, 'nothing owed any more');
});

test('paying more than is owed books only the extra as new salary', async () => {
  const { employee, salary, balances } = await setup();

  await salary({ amount: 20000, party: employee, onCredit: true });
  await salary({ amount: 30000, party: employee, method: 'cash' });

  const b = await balances();
  assert.equal(b.expense, toPaisa(30000), '20,000 accrued + 10,000 new');
  assert.equal(b.employee, 0);
});

test('paying less than is owed leaves the rest owed', async () => {
  const { employee, salary, balances } = await setup();

  await salary({ amount: 30000, party: employee, onCredit: true });
  await salary({ amount: 10000, party: employee, method: 'cash' });

  const b = await balances();
  assert.equal(b.expense, toPaisa(30000), 'no new expense on a part-payment');
  assert.equal(b.employee, -toPaisa(20000), '20,000 still owed');
});

test('paying an employee with nothing owed is plain salary expense', async () => {
  const { employee, salary, balances } = await setup();

  await salary({ amount: 15000, party: employee, method: 'cash' });

  const b = await balances();
  assert.equal(b.expense, toPaisa(15000));
  assert.equal(b.employee, 0, 'a paid employee never shows as owing us');
});

test('salary can only be tagged to an employee of the business', async () => {
  const { biz, salary } = await setup();
  const supplier = await makeParty(biz._id, 'supplier');
  await assert.rejects(
    salary({ amount: 1000, party: String(supplier._id), method: 'cash' }),
    /not an employee/
  );
});
