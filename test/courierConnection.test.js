import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
import Party from '../models/Party.js';
import {
  getConnection,
  saveConnection,
  testConnection,
  removeConnection
} from '../controllers/courierConnectionController.js';
import { courierConnectionSchema } from '../schemas/parties.js';
import { encryptSecret, decryptSecret } from '../utils/secretBox.js';
import { courierDeps } from '../utils/couriers/index.js';
import { requireAdmin } from '../middlewares/requireAdmin.js';

/**
 * A courier's key is saved encrypted, hidden from every normal read, and only ever goes IN. The
 * test button asks the courier (a fake one here) something harmless and records how it went.
 */
before(connect);
after(disconnect);
afterEach(async () => {
  courierDeps.fetchImpl = (...a) => fetch(...a);
  await clear();
});

process.env.COURIER_SECRET_KEY = crypto.randomBytes(32).toString('hex');
const admin = { id: userId, role: { fullAccess: true } };
const KEY = 'pk_live_super_secret_123';

let n = 0;
const courier = async (type = 'courier') => {
  const biz = await makeBusiness({ name: `Shop ${(n += 1)}` });
  return makeParty(biz._id, type);
};

const save = (party, body) =>
  runHandler(saveConnection, {
    user: admin,
    resource: party,
    body: courierConnectionSchema.parse(body)
  });

test('the key is encrypted when saved, and opens again only with the server key', () => {
  const saved = encryptSecret(KEY);
  assert.ok(!saved.includes(KEY));
  assert.match(saved, /^v1:/);
  assert.equal(decryptSecret(saved), KEY);
  assert.notEqual(encryptSecret(KEY), saved, 'a fresh IV every time');
  assert.throws(() => decryptSecret(saved.replace(/.$/, 'A')), /can not be opened|unreadable/);
});

test('without COURIER_SECRET_KEY nothing is stored in the clear — it is refused', async () => {
  const keep = process.env.COURIER_SECRET_KEY;
  delete process.env.COURIER_SECRET_KEY;
  try {
    assert.throws(() => encryptSecret(KEY), /not set up on this server/);
  } finally {
    process.env.COURIER_SECRET_KEY = keep;
  }
});

test('saving a key stores it encrypted and the response says only that a key exists', async () => {
  const party = await courier();
  const out = await save(party, { provider: 'postex', token: KEY, pickupAddressCode: '001' });
  assert.equal(out.body.data.hasToken, true);
  assert.equal(out.body.data.pickupAddressCode, '001');
  assert.ok(!JSON.stringify(out.body).includes(KEY));

  const raw = await mongoose.connection.collection('parties').findOne({ _id: party._id });
  assert.ok(raw.integration.tokenEnc);
  assert.ok(!raw.integration.tokenEnc.includes(KEY), 'not in the database in the clear');
});

test('a normal read of the party never carries the key', async () => {
  const party = await courier();
  await save(party, { provider: 'postex', token: KEY });
  const read = await Party.findById(party._id);
  assert.equal(read.integration.tokenEnc, undefined);
  assert.ok(!JSON.stringify(read.toJSON()).includes('tokenEnc'));
  assert.equal(read.integration.hasToken, true);
});

test('booking can not be switched on before a key is saved', async () => {
  const party = await courier();
  await assert.rejects(
    save(party, { provider: 'postex', isEnabled: true }),
    /Save the key first|before turning booking on/
  );
});

test('a supplier can not be connected to a courier service', async () => {
  const party = await courier('supplier');
  await assert.rejects(save(party, { provider: 'postex', token: KEY }), /Only a courier/);
});

test('only an admin may use these — the guard says 403 to anyone else', () => {
  let error;
  requireAdmin({ user: { role: { fullAccess: false } } }, {}, e => (error = e));
  assert.equal(error.statusCode, 403);
  let ok = false;
  requireAdmin({ user: admin }, {}, e => (ok = !e));
  assert.equal(ok, true);
});

test('the key itself is too short to be real → refused before anything is saved', () => {
  assert.equal(courierConnectionSchema.safeParse({ token: 'abc' }).success, false);
});

test('test connection asks PostEx for the addresses and records the time', async () => {
  const party = await courier();
  await save(party, { provider: 'postex', token: KEY });
  const seen = [];
  courierDeps.fetchImpl = async (url, init) => {
    seen.push({ url: String(url), token: init.headers.token });
    return new Response(
      JSON.stringify({
        statusCode: '200',
        dist: [{ addressCode: '001', address: 'Shop 4', cityName: 'Lahore' }]
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };
  const out = await runHandler(testConnection, {
    user: admin,
    resource: await Party.findById(party._id)
  });
  assert.equal(out.body.data.addresses[0].addressCode, '001');
  assert.equal(seen[0].token, KEY, 'the courier gets the real key, decrypted only for this call');

  const saved = await Party.findById(party._id);
  assert.ok(saved.integration.lastCheckedAt);
  assert.equal(saved.integration.lastError, undefined);
});

test('a refused key is recorded as the reason, and the caller sees PostEx’s message', async () => {
  const party = await courier();
  await save(party, { provider: 'postex', token: KEY });
  courierDeps.fetchImpl = async () => new Response('', { status: 401 });
  await assert.rejects(
    runHandler(testConnection, { user: admin, resource: await Party.findById(party._id) }),
    /did not accept the saved key/
  );
  assert.match((await Party.findById(party._id)).integration.lastError, /did not accept/);
});

test('a courier that is not connected says so', async () => {
  const party = await courier();
  await assert.rejects(
    runHandler(testConnection, { user: admin, resource: party }),
    /not connected/
  );
});

test('disconnecting forgets the key completely', async () => {
  const party = await courier();
  await save(party, { provider: 'postex', token: KEY });
  await runHandler(removeConnection, { user: admin, resource: await Party.findById(party._id) });
  const raw = await mongoose.connection.collection('parties').findOne({ _id: party._id });
  assert.equal(raw.integration, undefined);
  const view = await runHandler(getConnection, { resource: await Party.findById(party._id) });
  assert.equal(view.body.data.hasToken, false);
});

test('changing the pickup address or the on/off switch keeps the saved key', async () => {
  const party = await courier();
  await save(party, { provider: 'postex', token: KEY });
  await save(await Party.findById(party._id), { pickupAddressCode: '002', isEnabled: true });
  await save(await Party.findById(party._id), { isEnabled: false });

  const saved = await Party.findById(party._id).select('+integration.tokenEnc');
  assert.equal(decryptSecret(saved.integration.tokenEnc), KEY, 'the key survived every later save');
  assert.equal(saved.integration.pickupAddressCode, '002');
  assert.equal(saved.integration.isEnabled, false);
});
