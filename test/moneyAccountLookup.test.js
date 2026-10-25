import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, makeBusiness, runHandler, oid } from './helpers/db.js';
import { lookupMoneyAccounts, getMoneyAccounts } from '../controllers/moneyAccountController.js';
import { admin } from './helpers/courier.js';

/**
 * Taking an advance or the cash at the door needs "which account?" — not the bank balances or the
 * cash book. The lookup carries the choices only.
 */
before(connect);
after(disconnect);
afterEach(clear);

const userWith = (businesses, ...grants) => ({
  id: oid(),
  assignedBusinesses: businesses.map(b => b._id),
  role: {
    permissions: grants.map(([resource, actions, scope = 'own']) => ({ resource, actions, scope }))
  }
});
const ask = (user, query) => runHandler(lookupMoneyAccounts, { user, query });

test('an order taker can choose an account and sees no balance', async () => {
  const biz = await makeBusiness();
  const taker = userWith([biz], ['orders', ['read', 'create', 'update']]);
  const out = await ask(taker, { business: String(biz._id) });

  assert.ok(out.body.data.accounts.length >= 1, 'cash and bank are offered');
  for (const a of out.body.data.accounts) {
    assert.ok(a.name && a._id);
    assert.equal('balance' in a, false);
    assert.equal('balancePaisa' in a, false);
  }
});

test('the full list still carries balances — for those allowed the journal', async () => {
  const biz = await makeBusiness();
  const out = await runHandler(getMoneyAccounts, {
    user: admin,
    accessFilter: {},
    query: { business: String(biz._id) }
  });
  assert.ok('balance' in out.body.data.accounts[0]);
});

test('someone with no order or journal rights can not choose an account', async () => {
  const biz = await makeBusiness();
  const nobody = userWith([biz], ['products', ['read']]);
  await assert.rejects(ask(nobody, { business: String(biz._id) }), /do not have permission/);
});

test('another business looks like it does not exist', async () => {
  const mine = await makeBusiness({ name: 'Mine' });
  const theirs = await makeBusiness({ name: 'Theirs' });
  const taker = userWith([mine], ['orders', ['update']]);
  await assert.rejects(ask(taker, { business: String(theirs._id) }), /Business not found/);
});

test('a business is required', async () => {
  await assert.rejects(ask(admin, {}), /Select a business/);
});
