import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  connect,
  clear,
  disconnect,
  makeBusiness,
  makeParty,
  runHandler,
  userId
} from './helpers/db.js';
import Partner from '../models/Partner.js';
import { accountBalance } from '../utils/ledger.js';
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { listMoneyAccounts, createMoneyAccount, resolveMoney } from '../utils/moneyAccounts.js';
import { recordExpense, getMoneySummary } from '../controllers/financeController.js';
import {
  addMoneyAccount,
  updateMoneyAccount,
  recordTransfer
} from '../controllers/moneyAccountController.js';
import { recordPartyTransaction } from '../controllers/partyController.js';
import {
  createPartner,
  withdrawPartner,
  investPartner,
  getPartners,
  PARTNER_LIST_FIELDS
} from '../controllers/partnerController.js';
import { expenseSchema, moneyAccountCreateSchema, transferSchema } from '../schemas/finance.js';
import { partyTransactionSchema } from '../schemas/parties.js';
import { capitalMoveSchema } from '../schemas/partners.js';
import { toPaisa } from '../utils/money.js';

/**
 * Every place money sits is its own account — cash, each bank, each wallet — and
 * a partner can hold or pay business money personally. Money moves name WHERE,
 * and the books follow each place separately.
 */

before(connect);
after(disconnect);
afterEach(clear);

const admin = { id: userId, role: { fullAccess: true } };
const staff = {
  id: userId,
  role: { permissions: [{ resource: 'journal', actions: ['read', 'create'], scope: 'all' }] }
};

const balance = async (biz, account) => accountBalance(biz._id, account);

const addWallet = async biz =>
  (
    await runHandler(addMoneyAccount, {
      user: admin,
      body: moneyAccountCreateSchema.parse({
        business: String(biz._id),
        name: 'JazzCash 0300',
        kind: 'wallet',
        number: '0300 1234567'
      })
    })
  ).body.data;

const addPartner = async biz =>
  (
    await runHandler(createPartner, {
      user: admin,
      body: { business: String(biz._id), name: 'Hamza', sharePercent: 40 }
    })
  ).body.data;

test('a business starts with Cash and Main bank; wallets and banks can be added', async () => {
  const biz = await makeBusiness();
  const wallet = await addWallet(biz);
  assert.equal(wallet.code, '1051');
  assert.equal(wallet.moneyKind, 'wallet');

  const { accounts } = await listMoneyAccounts(biz._id, admin);
  assert.deepEqual(
    accounts.map(a => [a.name, a.kind]),
    [
      ['Cash', 'cash'],
      ['Main bank', 'bank'],
      ['JazzCash 0300', 'wallet']
    ]
  );

  const bank = await createMoneyAccount(biz._id, { name: 'HBL', kind: 'bank' }, userId);
  assert.equal(bank.code, '1011');
});

test('money moved "from JazzCash" comes off JazzCash, not cash', async () => {
  const biz = await makeBusiness();
  const wallet = await addWallet(biz);

  await runHandler(recordExpense, {
    user: admin,
    body: expenseSchema.parse({
      business: String(biz._id),
      amount: 3500,
      category: CODES.UTILITIES,
      account: String(wallet._id)
    })
  });

  assert.equal(await balance(biz, wallet._id), -toPaisa(3500));
  assert.equal(await balance(biz, (await accountByCode(biz._id, CODES.CASH))._id), 0);
});

test("another business's account, a closed one, or junk is refused", async () => {
  const biz = await makeBusiness({ name: 'Lawn' });
  const other = await makeBusiness({ name: 'Noor' });
  const theirs = await addWallet(other);

  await assert.rejects(resolveMoney(biz._id, { account: String(theirs._id) }), /money accounts/);
  await assert.rejects(resolveMoney(biz._id, { account: 'not-an-id' }), /money accounts/);

  const mine = await addWallet(biz);
  await runHandler(updateMoneyAccount, {
    user: admin,
    resource: mine,
    body: { isActive: false }
  });
  await assert.rejects(resolveMoney(biz._id, { account: String(mine._id) }), /closed/);
});

test('an account closes only at zero, and the original two never close', async () => {
  const biz = await makeBusiness();
  const wallet = await addWallet(biz);
  await runHandler(recordExpense, {
    user: admin,
    body: expenseSchema.parse({
      business: String(biz._id),
      amount: 500,
      category: CODES.UTILITIES,
      account: String(wallet._id)
    })
  });
  await assert.rejects(
    runHandler(updateMoneyAccount, { user: admin, resource: wallet, body: { isActive: false } }),
    /move it out/
  );

  const cash = await accountByCode(biz._id, CODES.CASH);
  await assert.rejects(
    runHandler(updateMoneyAccount, { user: admin, resource: cash, body: { isActive: false } }),
    /always kept open/
  );
});

test('a customer paying into a partner: the partner holds it until they hand it over', async () => {
  const biz = await makeBusiness();
  const hamza = await addPartner(biz);
  const customer = await makeParty(biz._id, 'customer');
  const wallet = await addWallet(biz);
  const hamzaRef = `partner:${hamza._id}`;

  await runHandler(recordPartyTransaction, {
    user: admin,
    resource: customer,
    body: partyTransactionSchema.parse({ direction: 'got', amount: 12000, account: hamzaRef })
  });
  let partner = await Partner.findById(hamza._id);
  assert.equal(await balance(biz, partner.currentAccount), toPaisa(12000), 'Hamza holds 12,000');

  // He deposits it into the business wallet.
  await runHandler(recordTransfer, {
    user: admin,
    body: transferSchema.parse({
      business: String(biz._id),
      from: hamzaRef,
      to: String(wallet._id),
      amount: 12000
    })
  });
  partner = await Partner.findById(hamza._id);
  assert.equal(await balance(biz, partner.currentAccount), 0);
  assert.equal(await balance(biz, wallet._id), toPaisa(12000));

  const summary = await runHandler(getMoneySummary, {
    user: admin,
    query: { business: String(biz._id) }
  });
  assert.equal(summary.body.data.wallet, 12000);
  assert.equal(summary.body.data.partnersHolding, 0);
});

test('a partner keeping business money comes off their stake', async () => {
  const biz = await makeBusiness();
  const hamza = await addPartner(biz);
  const customer = await makeParty(biz._id, 'customer');
  const hamzaRef = `partner:${hamza._id}`;

  await runHandler(recordPartyTransaction, {
    user: admin,
    resource: customer,
    body: partyTransactionSchema.parse({ direction: 'got', amount: 5000, account: hamzaRef })
  });
  const partner = await Partner.findById(hamza._id);
  const out = await runHandler(withdrawPartner, {
    user: admin,
    resource: partner,
    body: capitalMoveSchema.parse({ amount: 5000, account: hamzaRef })
  });

  assert.equal(out.body.data.capital, -5000, 'his capital went down by what he kept');
  assert.equal(await balance(biz, partner.currentAccount), 0, 'and he no longer holds it');
});

test('a bill a partner paid is owed to them, and can become their investment', async () => {
  const biz = await makeBusiness();
  const hamza = await addPartner(biz);
  const hamzaRef = `partner:${hamza._id}`;

  await runHandler(recordExpense, {
    user: admin,
    body: expenseSchema.parse({
      business: String(biz._id),
      amount: 8000,
      category: CODES.RENT,
      account: hamzaRef
    })
  });
  let partner = await Partner.findById(hamza._id);
  assert.equal(await balance(biz, partner.currentAccount), -toPaisa(8000), 'business owes Hamza');

  const out = await runHandler(investPartner, {
    user: admin,
    resource: partner,
    body: capitalMoveSchema.parse({ amount: 8000, account: hamzaRef })
  });
  partner = await Partner.findById(hamza._id);
  assert.equal(out.body.data.capital, 8000);
  assert.equal(await balance(biz, partner.currentAccount), 0);
});

test('staff can only use the business accounts, never a partner', async () => {
  const biz = await makeBusiness();
  const hamza = await addPartner(biz);

  await assert.rejects(
    runHandler(recordExpense, {
      user: staff,
      body: expenseSchema.parse({
        business: String(biz._id),
        amount: 100,
        category: CODES.UTILITIES,
        account: `partner:${hamza._id}`
      })
    }),
    /partner/
  );
  const { partners } = await listMoneyAccounts(biz._id, staff);
  assert.equal(partners.length, 0, 'partners are not even listed for staff');
});

test('the partners list shows what each partner holds, like their own page', async () => {
  const biz = await makeBusiness();
  const hamza = await addPartner(biz);
  const customer = await makeParty(biz._id, 'customer');
  await runHandler(recordPartyTransaction, {
    user: admin,
    resource: customer,
    body: partyTransactionSchema.parse({
      direction: 'got',
      amount: 1500,
      account: `partner:${hamza._id}`
    })
  });

  // The list reads documents through the route's lean projection — a field it
  // leaves out (like the running account) silently reads as 0.
  const listed = await Partner.find({ business: biz._id }).select(PARTNER_LIST_FIELDS);
  const body = await new Promise(resolve => {
    const res = {
      advancedResults: { success: true, data: listed },
      status() {
        return this;
      },
      json: resolve
    };
    getPartners({ user: admin }, res, () => {});
  });
  assert.equal(body.data[0].current, 1500);
});
