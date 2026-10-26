import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  connect,
  clear,
  disconnect,
  makeBusiness,
  makeParty,
  runHandler,
  oid
} from './helpers/db.js';
import Party from '../models/Party.js';
import { lookupParties } from '../controllers/partyLookupController.js';
import { lookupScope } from '../utils/partyLookup.js';
import { admin } from './helpers/courier.js';

/**
 * Choosing a courier at dispatch must not need the whole Khata. The lookup answers only "who can I
 * pick?" — and only for the kind of person the person's own task needs.
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

const ask = (user, query) => runHandler(lookupParties, { user, query });

test('a dispatcher with no Khata access can pick a courier, and sees no money', async () => {
  const biz = await makeBusiness();
  const courier = await makeParty(biz._id, 'courier', { name: 'PostEx', phone: '03001112223' });
  const dispatcher = userWith([biz], ['orders', ['read', 'update']]);

  const out = await ask(dispatcher, { business: String(biz._id), type: 'courier' });
  assert.equal(out.body.data.length, 1);
  assert.equal(out.body.data[0].name, 'PostEx');
  assert.equal(String(out.body.data[0]._id), String(courier._id));
  for (const secret of ['balance', 'balancePaisa', 'note', 'integration']) {
    assert.equal(secret in out.body.data[0], false, `${secret} must not be in a lookup`);
  }
});

test('the same dispatcher can not browse suppliers, resellers or lenders', async () => {
  const biz = await makeBusiness();
  await makeParty(biz._id, 'supplier', { name: 'Bilal Fabrics' });
  const dispatcher = userWith([biz], ['orders', ['read', 'update']]);

  for (const type of ['supplier', 'reseller', 'employee', 'lender']) {
    await assert.rejects(
      ask(dispatcher, { business: String(biz._id), type }),
      /do not have permission/
    );
  }
});

test('someone with no relevant permission can look nobody up', async () => {
  const biz = await makeBusiness();
  const nobody = userWith([biz], ['products', ['read']]);
  await assert.rejects(
    ask(nobody, { business: String(biz._id), type: 'courier' }),
    /do not have permission/
  );
});

test('an order taker may find a walk-in customer account, not a courier', async () => {
  const biz = await makeBusiness();
  await makeParty(biz._id, 'customer', { name: 'Walk-in Hira' });
  await makeParty(biz._id, 'courier', { name: 'TCS' });
  const taker = userWith([biz], ['orders', ['read', 'create']]);

  const found = await ask(taker, { business: String(biz._id), type: 'customer' });
  assert.equal(found.body.data[0].name, 'Walk-in Hira');
  await assert.rejects(
    ask(taker, { business: String(biz._id), type: 'courier' }),
    /do not have permission/
  );
});

test('Khata access still finds everyone', async () => {
  const biz = await makeBusiness();
  await makeParty(biz._id, 'supplier', { name: 'Bilal Fabrics' });
  const keeper = userWith([biz], ['parties', ['read']]);
  const out = await ask(keeper, { business: String(biz._id), type: 'supplier' });
  assert.equal(out.body.data.length, 1);
});

test('a business you are not assigned to looks like it does not exist', async () => {
  const mine = await makeBusiness({ name: 'Mine' });
  const theirs = await makeBusiness({ name: 'Theirs' });
  await makeParty(theirs._id, 'courier', { name: 'Their courier' });
  const dispatcher = userWith([mine], ['orders', ['update']]);
  await assert.rejects(
    ask(dispatcher, { business: String(theirs._id), type: 'courier' }),
    /Business not found/
  );
});

test('an all-businesses permission reaches any business, an admin always does', async () => {
  const biz = await makeBusiness();
  await makeParty(biz._id, 'courier', { name: 'PostEx' });
  const roaming = userWith([], ['orders', ['update'], 'all']);
  assert.equal(
    (await ask(roaming, { business: String(biz._id), type: 'courier' })).body.data.length,
    1
  );
  assert.equal(
    (await ask(admin, { business: String(biz._id), type: 'courier' })).body.data.length,
    1
  );
});

test('search narrows the list, inactive parties are not offered, and the limit holds', async () => {
  const biz = await makeBusiness();
  for (const name of [
    'PostEx',
    'TCS',
    'Leopards',
    'Pakistan Post',
    'M&P',
    'Trax',
    'Call Courier'
  ]) {
    await makeParty(biz._id, 'courier', { name });
  }
  await Party.updateOne({ name: 'TCS' }, { isActive: false });
  const dispatcher = userWith([biz], ['orders', ['update']]);
  const q = extra => ask(dispatcher, { business: String(biz._id), type: 'courier', ...extra });

  assert.deepEqual(
    (await q({ search: 'post' })).body.data.map(p => p.name),
    ['Pakistan Post', 'PostEx']
  );
  assert.equal((await q({ search: 'tcs' })).body.data.length, 0, 'switched off, so not offered');
  assert.equal((await q({ limit: '3' })).body.data.length, 3);
  assert.equal((await q({ search: '(((' })).body.data.length, 0, 'regex characters are literal');
});

test('a courier says whether booking with its service is switched on', async () => {
  const biz = await makeBusiness();
  const courier = await makeParty(biz._id, 'courier', { name: 'PostEx' });
  await Party.updateOne({ _id: courier._id }, { $set: { 'integration.isEnabled': true } });
  const dispatcher = userWith([biz], ['orders', ['update']]);
  const out = await ask(dispatcher, { business: String(biz._id), type: 'courier' });
  assert.equal(out.body.data[0].booksWithService, true);
});

test('a business and a real kind of party are both required', async () => {
  const biz = await makeBusiness();
  await assert.rejects(ask(admin, { type: 'courier' }), /Select a business/);
  await assert.rejects(
    ask(admin, { business: String(biz._id), type: 'wizard' }),
    /which kind of party/
  );
});

test('the scope is the widest permission that allows it', () => {
  const biz = { _id: oid() };
  assert.equal(lookupScope(userWith([biz], ['orders', ['update'], 'own']), 'courier'), 'own');
  assert.equal(
    lookupScope(
      userWith([biz], ['orders', ['update'], 'own'], ['parties', ['read'], 'all']),
      'courier'
    ),
    'all'
  );
  assert.equal(lookupScope(userWith([biz], ['orders', ['update']]), 'supplier'), null);
});

test('it pages like every list: five at a time, a next page while more remain, none after the last', async () => {
  const biz = await makeBusiness();
  for (const name of ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7']) {
    await makeParty(biz._id, 'courier', { name });
  }
  const dispatcher = userWith([biz], ['orders', ['update']]);
  const q = page =>
    ask(dispatcher, { business: String(biz._id), type: 'courier', limit: '5', page });

  const first = await q('1');
  assert.deepEqual(
    first.body.data.map(p => p.name),
    ['A1', 'A2', 'A3', 'A4', 'A5']
  );
  assert.deepEqual(first.body.pagination, { next: { page: 2, limit: 5 } });

  const second = await q('2');
  assert.deepEqual(
    second.body.data.map(p => p.name),
    ['A6', 'A7']
  );
  assert.deepEqual(second.body.pagination, {}, 'the last page names no next page');
});
