import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import {
  connect,
  clear,
  disconnect,
  makeBusiness,
  makeParty,
  runHandler,
  userId
} from './helpers/db.js';
import Account from '../models/Account.js';
import JournalEntry from '../models/JournalEntry.js';
import Order from '../models/Order.js';
import PeriodLock from '../models/PeriodLock.js';
import ShopifyConnection from '../models/ShopifyConnection.js';
import Party from '../models/Party.js';
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { accountBalance, postEntry, reverseEntry, trialBalance } from '../utils/ledger.js';
import { courierWalletFor } from '../utils/moneyAccounts.js';
import { planLedgerClear } from '../utils/ledgerClear.js';
import { ledgerClear, ledgerClearPreview, resetData } from '../controllers/systemController.js';

/**
 * Clearing the ledger keeps the business's orders: only the entries a person typed by hand go (expenses, payments,
 * transfers, capital, salaries, opening balances, manual) — never the entries the system posted itself, never a PostEx
 * wallet withdrawal, never a customer's payment. The books still balance afterwards, and a copy is written first.
 */
const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bledger-ledger-'));
process.env.RESET_SNAPSHOT_DIR = snapshotDir;

before(connect);
after(async () => {
  fs.rmSync(snapshotDir, { recursive: true, force: true });
  await disconnect();
});
afterEach(() => {
  delete process.env.ALLOW_LEDGER_CLEAR;
  delete process.env.ALLOW_DATA_RESET;
  return clear();
});

const ADMIN = { id: userId, role: { fullAccess: true } };
const entry = async (biz, kind, lines, memo = kind) =>
  postEntry({ business: biz._id, memo, source: { kind }, lines, userId });
const acc = (biz, code) => accountByCode(biz._id, code).then(a => a._id);
const clearIt = (biz, confirmName = biz.name) =>
  runHandler(ledgerClear, { user: ADMIN, body: { business: String(biz._id), confirmName } });

/** A business with a bit of everything: hand-typed money and the system's own entries. */
async function world() {
  const biz = await makeBusiness({ name: 'Real Shop', isProtected: true });
  const courier = await makeParty(biz._id, 'courier', {
    integration: { provider: 'postex', isEnabled: true }
  });
  const customer = await makeParty(biz._id, 'customer');
  const supplier = await makeParty(biz._id, 'supplier');
  const wallet = await courierWalletFor(biz._id, courier, userId);
  const cash = await acc(biz, CODES.CASH);
  const bank = await acc(biz, CODES.BANK);
  const capital = await acc(biz, CODES.OWNER_CAPITAL ?? '3000');
  const sales = await acc(biz, CODES.SALES);
  const receivable = await acc(biz, CODES.COD_RECEIVABLE);
  const advances = await acc(biz, CODES.CUSTOMER_ADVANCES);
  const payable = await acc(biz, CODES.ACCOUNTS_PAYABLE);
  const ar = await acc(biz, CODES.ACCOUNTS_RECEIVABLE);
  const misc = await acc(biz, CODES.MISC_EXPENSE ?? '5900');

  const typed = {
    capital: await entry(biz, 'capital', [
      { account: cash, debitPaisa: 1000000 },
      { account: capital, creditPaisa: 1000000 }
    ]),
    expense: await entry(biz, 'expense', [
      { account: misc, debitPaisa: 25000 },
      { account: cash, creditPaisa: 25000 }
    ]),
    supplierPayment: await entry(biz, 'payment', [
      { account: payable, party: supplier._id, debitPaisa: 70000 },
      { account: bank, creditPaisa: 70000 }
    ]),
    opening: await entry(biz, 'opening', [
      { account: ar, party: customer._id, debitPaisa: 50000 },
      { account: capital, creditPaisa: 50000 }
    ]),
    transfer: await entry(biz, 'transfer', [
      { account: bank, debitPaisa: 30000 },
      { account: cash, creditPaisa: 30000 }
    ])
  };
  // Money the owner asked to keep:
  const kept = {
    walletWithdrawal: await entry(biz, 'transfer', [
      { account: bank, debitPaisa: 90000 },
      { account: wallet._id, creditPaisa: 90000 }
    ]),
    customerPayment: await entry(biz, 'payment', [
      { account: cash, debitPaisa: 40000 },
      { account: ar, party: customer._id, creditPaisa: 40000 }
    ]),
    sale: await entry(biz, 'order', [
      { account: receivable, party: courier._id, debitPaisa: 380000 },
      { account: sales, creditPaisa: 380000 }
    ]),
    advance: await entry(biz, 'order-advance', [
      { account: bank, debitPaisa: 100000 },
      { account: advances, creditPaisa: 100000 }
    ]),
    receipt: await entry(biz, 'courier-receipt', [
      { account: wallet._id, debitPaisa: 363100 },
      { account: receivable, party: courier._id, creditPaisa: 363100 }
    ])
  };
  await PeriodLock.create({
    business: biz._id,
    periodEnd: new Date('2026-09-30'),
    createdBy: userId
  });
  return { biz, courier, customer, wallet, cash, bank, typed, kept };
}

const ids = async biz =>
  new Set((await JournalEntry.find({ business: biz._id }).lean()).map(e => String(e._id)));

test('deletes only what a person typed; keeps the system’s entries, wallet withdrawals and customer payments', async () => {
  process.env.ALLOW_LEDGER_CLEAR = 'true';
  const w = await world();
  const walletBefore = await accountBalance(w.biz._id, w.wallet._id);

  const out = await clearIt(w.biz);
  assert.equal(out.body.data.deleted, 5, 'capital, expense, supplier payment, opening, transfer');

  const left = await ids(w.biz);
  for (const e of Object.values(w.typed)) assert.ok(!left.has(String(e._id)), `${e.memo} is gone`);
  for (const [name, e] of Object.entries(w.kept))
    assert.ok(left.has(String(e._id)), `${name} stays`);

  assert.equal(
    await accountBalance(w.biz._id, w.wallet._id),
    walletBefore,
    'the PostEx wallet is untouched'
  );
  assert.equal(await PeriodLock.countDocuments({ business: w.biz._id }), 0, 'period locks go too');
  assert.equal((await trialBalance(w.biz._id)).balanced, true, 'the books still balance');
});

test('a reversed entry and its reversal go together — never half a pair', async () => {
  process.env.ALLOW_LEDGER_CLEAR = 'true';
  const w = await world();
  const reversal = await reverseEntry(w.typed.expense._id, { userId });
  const out = await clearIt(w.biz);
  assert.equal(out.body.data.deleted, 6);
  const left = await ids(w.biz);
  assert.ok(!left.has(String(w.typed.expense._id)) && !left.has(String(reversal._id)));
});

test('the preview shows each balance now and after, in rupees, before anything is deleted', async () => {
  const w = await world();
  const before = await JournalEntry.countDocuments();
  const out = await runHandler(ledgerClearPreview, {
    user: ADMIN,
    query: { business: String(w.biz._id) }
  });
  assert.equal(await JournalEntry.countDocuments(), before, 'nothing deleted by looking');
  assert.equal(out.body.data.enabled, false);
  assert.equal(out.body.data.entries, 5);
  assert.equal(out.body.data.periodLocks, 1);
  assert.ok(out.body.data.byKind.some(k => k.label === 'expenses' && k.count === 1));
  const cash = out.body.data.balances.find(b => b.id === String(w.cash));
  // Cash now: +10,000 capital − 250 expense − (−300 transfer out) …; after: only the customer payment of 400.
  assert.equal(cash.after, 400);
  assert.notEqual(cash.now, cash.after);
  const bank = out.body.data.balances.find(b => b.id === String(w.bank));
  assert.ok(bank, 'the bank changes too');
});

test('what the preview says the balances will be is what they are afterwards', async () => {
  process.env.ALLOW_LEDGER_CLEAR = 'true';
  const w = await world();
  const plan = await planLedgerClear(w.biz._id);
  await clearIt(w.biz);
  for (const b of plan.balances.filter(r => r.kind === 'money')) {
    assert.equal(await accountBalance(w.biz._id, b.id), b.afterPaisa, `${b.name}`);
  }
});

test('refuses unless the server switch is on, or the typed name is wrong', async () => {
  const w = await world();
  await assert.rejects(clearIt(w.biz), /switched off/);
  process.env.ALLOW_LEDGER_CLEAR = 'true';
  await assert.rejects(clearIt(w.biz, 'real shop'), /Type the business name exactly/);
  assert.equal(await JournalEntry.countDocuments({ business: w.biz._id }), 10, 'nothing deleted');
});

test('works on a protected business, and writes a safety copy of exactly what it deletes first', async () => {
  process.env.ALLOW_LEDGER_CLEAR = 'true';
  const w = await world();
  assert.equal((await mongoose.model('Business').findById(w.biz._id)).isProtected, true);
  await clearIt(w.biz);
  const file = fs.readdirSync(snapshotDir).find(f => f.startsWith(`${w.biz._id}-ledger-`));
  assert.ok(file, 'the copy exists');
  const lines = fs
    .readFileSync(path.join(snapshotDir, file), 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l));
  assert.equal(lines.filter(l => l.collection === 'journalentries').length, 5);
  assert.equal(lines.filter(l => l.collection === 'periodlocks').length, 1);
});

test('orders and connections are untouched by a ledger clear', async () => {
  process.env.ALLOW_LEDGER_CLEAR = 'true';
  const w = await world();
  await ShopifyConnection.collection.insertOne({ business: w.biz._id, clientId: 'x' });
  await Order.collection.insertOne({ business: w.biz._id, orderNumber: '0001' });
  await clearIt(w.biz);
  assert.equal(await ShopifyConnection.collection.countDocuments({ business: w.biz._id }), 1);
  assert.equal(await Order.collection.countDocuments({ business: w.biz._id }), 1);
  assert.ok(await Party.findById(w.courier._id), 'the courier and its saved key stay');
  assert.equal(await Account.countDocuments({ business: w.biz._id, heldByCourier: true }), 1);
});

/** The full reset keeps the Shopify connection and every connected courier, so nothing has to be reconnected. */
test('a full reset keeps the Shopify connection and connected couriers, and clears the rest', async () => {
  process.env.ALLOW_DATA_RESET = 'true';
  const biz = await makeBusiness({ name: 'Test Shop' });
  const courier = await makeParty(biz._id, 'courier', { integration: { provider: 'postex' } });
  await makeParty(biz._id, 'supplier');
  await courierWalletFor(biz._id, courier, userId);
  await ShopifyConnection.collection.insertOne({ business: biz._id, clientId: 'x' });
  await Order.collection.insertOne({ business: biz._id, orderNumber: '0001' });
  await entry(biz, 'expense', [
    { account: await acc(biz, CODES.CASH), creditPaisa: 100 },
    { account: await acc(biz, CODES.MISC_EXPENSE ?? '5900'), debitPaisa: 100 }
  ]);
  await Party.updateOne({ _id: courier._id }, { $set: { defaultMoneyAccount: biz._id } });

  await runHandler(resetData, {
    user: ADMIN,
    body: { business: String(biz._id), confirmName: 'Test Shop' }
  });

  assert.equal(await ShopifyConnection.collection.countDocuments({ business: biz._id }), 1);
  const kept = await Party.find({ business: biz._id }).lean();
  assert.deepEqual(
    kept.map(p => p.name),
    [courier.name],
    'only the connected courier stays'
  );
  assert.equal(
    kept[0].defaultMoneyAccount,
    undefined,
    'its saved account is gone with the accounts'
  );
  assert.equal(await Order.collection.countDocuments({ business: biz._id }), 0);
  assert.equal(await JournalEntry.countDocuments({ business: biz._id }), 0);
  assert.equal(await Account.countDocuments({ business: biz._id }), 0);
});
