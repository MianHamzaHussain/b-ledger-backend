import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, makeBusiness, runHandler } from './helpers/db.js';
import Account from '../models/Account.js';
import Party from '../models/Party.js';
import { addCourier, getProviders, listCouriers } from '../controllers/courierController.js';
import { courierCreateSchema } from '../schemas/couriers.js';
import { userCan } from '../utils/permissions.js';
import { admin, fakePostex, restoreFetch } from './helpers/courier.js';

/**
 * The Couriers tab: a courier is added in one step, and a failure leaves nothing behind.
 */
before(connect);
after(disconnect);
afterEach(async () => {
  restoreFetch();
  await clear();
});

const add = (business, extra = {}) =>
  runHandler(addCourier, {
    user: admin,
    body: courierCreateSchema.parse({
      business: String(business._id),
      name: 'PostEx Faisalabad',
      provider: 'postex',
      token: 'pk_live_key_12345',
      ...extra
    })
  });

test('one step makes the khata party, saves the key, picks the only pickup address and turns booking on', async () => {
  fakePostex({});
  const biz = await makeBusiness({ name: 'Courier Tab Shop' });
  const out = await add(biz);

  assert.equal(out.status, 201);
  assert.equal(out.body.data.needsPickup, false);
  const party = await Party.findById(out.body.data.courier._id).select('+integration.tokenEnc');
  assert.equal(party.type, 'courier');
  assert.equal(party.integration.provider, 'postex');
  assert.ok(party.integration.tokenEnc, 'the key is saved…');
  assert.ok(!JSON.stringify(out.body).includes('pk_live_key_12345'), '…and never sent back');
  assert.equal(party.integration.isEnabled, true);
  assert.equal(party.integration.pickupAddressCode, '001');
  assert.equal(party.integration.autoConfirm, true);
  assert.equal(
    party.integration.adoptTyped,
    undefined,
    'following typed numbers is on unless set false'
  );
});

test('the wallet account is made, but recording payments stays off until a person turns it on', async () => {
  fakePostex({});
  const biz = await makeBusiness({ name: 'Courier Wallet Shop' });
  const out = await add(biz);

  const wallet = await Account.findOne({ business: biz._id, courier: out.body.data.courier._id });
  assert.ok(wallet, 'a wallet exists');
  assert.equal(wallet.heldByCourier, true);
  assert.equal(out.body.data.walletMade, true);
  const party = await Party.findById(out.body.data.courier._id);
  assert.ok(!party.integration.recordPayments, 'real money is not posted until it is checked');
});

test('more than one pickup address: the courier is added, booking waits for the person to choose', async () => {
  fakePostex({
    addresses: [
      { addressCode: '001', address: 'Shop 1', cityName: 'Lahore' },
      { addressCode: '002', address: 'Shop 2', cityName: 'Faisalabad' }
    ]
  });
  const biz = await makeBusiness({ name: 'Two Address Shop' });
  const out = await add(biz);

  assert.equal(out.body.data.needsPickup, true);
  assert.equal(out.body.data.addresses.length, 2);
  assert.equal(out.body.data.courier.connection.isEnabled, false);
});

test("a wrong key adds nothing: no party, no wallet, and the courier's own words come back", async () => {
  fakePostex({ badKey: true });
  const biz = await makeBusiness({ name: 'Wrong Key Shop' });

  await assert.rejects(() => add(biz), /did not accept the saved key/);
  assert.equal(await Party.countDocuments({ business: biz._id }), 0);
  assert.equal(await Account.countDocuments({ business: biz._id, courier: { $exists: true } }), 0);
});

test('a courier tracked by hand is just a khata party: no key, no wallet, nothing to test', async () => {
  const { calls } = fakePostex({});
  const biz = await makeBusiness({ name: 'Manual Courier Shop' });
  const out = await runHandler(addCourier, {
    user: admin,
    body: courierCreateSchema.parse({ business: String(biz._id), name: 'Leopards (by hand)' })
  });

  assert.equal(out.body.data.courier.connection.provider, null);
  assert.equal(out.body.data.walletMade, false);
  assert.equal(calls.length, 0, "the courier's service is never called");
});

test('the form needs the key for PostEx and every detail for TCS', () => {
  const base = { business: '6ae47c3c75622046865a2310', name: 'X' };
  assert.throws(
    () => courierCreateSchema.parse({ ...base, provider: 'postex' }),
    /Paste the PostEx key/
  );
  assert.throws(
    () => courierCreateSchema.parse({ ...base, provider: 'tcs' }),
    /all the TCS details/
  );
  assert.doesNotThrow(() => courierCreateSchema.parse(base));
});

test('the list shows each courier with its connection, wallet and balance, and never the key', async () => {
  fakePostex({});
  const biz = await makeBusiness({ name: 'List Shop' });
  await add(biz);
  const out = await runHandler(listCouriers, { user: admin, query: { business: String(biz._id) } });

  assert.equal(out.body.count, 1);
  const [c] = out.body.data;
  assert.equal(c.connection.hasToken, true);
  assert.equal(c.wallet.name, 'PostEx Faisalabad wallet');
  assert.equal(c.parcelsOut, 0);
  assert.equal(c.balance, 0);
  assert.ok(!JSON.stringify(out.body).includes('tokenEnc'));
});

test("a business outside the person's own is not found, and the provider list names each form", async () => {
  const biz = await makeBusiness({ name: 'Not Mine' });
  await assert.rejects(
    () =>
      runHandler(listCouriers, {
        user: { id: admin.id },
        accessFilter: { business: { $in: ['6ae47c3c75622046865a2399'] } },
        query: { business: String(biz._id) }
      }),
    /Not found/
  );
  const { body } = await runHandler(getProviders, { user: admin });
  assert.deepEqual(
    body.data.map(p => p.id),
    ['postex', 'tcs']
  );
  assert.ok(body.data.every(p => p.fields.length > 0));
});

test('couriers is a registered permission: an owner can be given it, and a role without it cannot', () => {
  const owner = {
    role: {
      permissions: [{ resource: 'couriers', actions: ['read', 'create', 'update'], scope: 'own' }]
    }
  };
  assert.equal(userCan(owner, 'couriers', 'create'), true);
  assert.equal(userCan(owner, 'couriers', 'delete'), false, 'there is no delete');
  assert.equal(userCan({ role: { permissions: [] } }, 'couriers', 'read'), false);
});
