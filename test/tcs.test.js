import { test, before, after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
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
import { saveConnection, getConnection } from '../controllers/courierConnectionController.js';
import { courierConnectionSchema } from '../schemas/parties.js';
import { adapterFor, courierDeps } from '../utils/couriers/index.js';
import { createTcs, clearTcsSessions, splitName, addressLines } from '../utils/couriers/tcs.js';
import { CourierError } from '../utils/couriers/courierError.js';
import { phaseOf, PHASES } from '../utils/couriers/statusWords.js';
import { readStatus } from '../utils/courierSync.js';

/**
 * TCS is built from its API guide and has not met the live service yet, so these tests pin what the guide
 * says: the two-step sign-in (once per expiry), the fields a booking carries, how TCS's tracking words
 * become ours, and that sign-in details are saved encrypted, never shown again, and never in a message.
 */
before(connect);
after(disconnect);
beforeEach(clearTcsSessions);
afterEach(async () => {
  courierDeps.fetchImpl = (...a) => fetch(...a);
  await clear();
});

process.env.COURIER_SECRET_KEY = crypto.randomBytes(32).toString('hex');
const admin = { id: userId, role: { fullAccess: true } };
const CREDS = {
  clientId: '205659',
  clientSecret: 'S3cr3t-client',
  username: 'shopuser',
  password: 'P@ss-word-1'
};
const token = JSON.stringify(CREDS);

const reply = (body, status = 200, type = 'application/json') =>
  new Response(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': type }
  });

const COST_CENTERS = [
  {
    costcentercode: '001 - LHR',
    costcentercity: 'LAHORE',
    costcentername: 'Shop Lahore',
    phoneno: '03447274889',
    pickupaddress: 'Agrics Town, Raiwind Road, Lahore'
  }
];

/** A fake TCS: signs in, lists cities and cost centers, books, tracks, prints. */
const fakeTcs = ({
  expiry = new Date(Date.now() + 3600_000).toISOString(),
  badClient,
  bookError,
  rejectOnce,
  tracking = {},
  paid = []
} = {}) => {
  const calls = [];
  let rejected = false;
  courierDeps.fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    const call = {
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      method: init.method,
      auth: init.headers?.Authorization,
      body: init.body ? JSON.parse(init.body) : undefined
    };
    calls.push(call);
    if (u.pathname === '/auth/api/auth') {
      if (badClient) return reply({ result: null, status: false, code: '401' }, 401);
      return reply({ result: { accessToken: 'bearer-1', expiry }, status: true, code: '0200' });
    }
    if (u.pathname === '/ecom/api/authentication/token') {
      return reply({ accesstoken: 'access-1', expiry, message: 'success' });
    }
    if (rejectOnce && !rejected && u.pathname !== '/ecom/api/setup/citylistbycountry') {
      rejected = true;
      return reply({ code: 401, message: 'Invalid Bearer token', status: 'UnAuthorized' }, 401);
    }
    if (u.pathname === '/ecom/api/setup/citylistbycountry') {
      return reply({
        message: 'SUCCESS',
        data: [
          { citycode: 'KHI', cityname: 'KARACHI' },
          { citycode: 'LHE', cityname: 'LAHORE' }
        ]
      });
    }
    if (u.pathname === '/ecom/inquiry/costcenterinquiry') {
      return reply({ detail: COST_CENTERS, message: 'success' });
    }
    if (u.pathname === '/ecom/api/booking/create') {
      if (bookError) return reply({ error: [{ errorname: bookError }], message: 'Summary' }, 400);
      return reply({
        response: 'SUCCESS',
        consignmentNo: '99210301520',
        code: '200',
        status: true
      });
    }
    if (u.pathname === '/ecom/api/booking/cancel') {
      return reply({ message: 'SUCCESS', traceid: 'x' });
    }
    if (u.pathname === '/tracking/api/Tracking/GetDynamicTrackDetail') {
      const t = tracking[call.query.consignee];
      return reply(
        t ?? {
          shipmentinfo: null,
          deliveryinfo: null,
          message: 'FAIL',
          shipmentsummary: 'No Data Found/Invalid CN'
        }
      );
    }
    if (u.pathname === '/ecom/api/print/label') {
      const doc = await PDFDocument.create();
      doc.addPage();
      return reply(Buffer.from(await doc.save()), 200, 'application/pdf');
    }
    if (u.pathname === '/ecom/api/Payment/status') {
      const yes = paid.includes(call.query.consignmentno);
      return reply({
        detail: [{ 'payment status': yes ? 'Y' : 'N', 'payment date': yes ? '16/09/2024' : null }],
        message: 'SUCCESS'
      });
    }
    return reply({}, 404);
  };
  return calls;
};

const adapter = (extra = {}) =>
  createTcs({
    token,
    account: '04011K1',
    fetchImpl: (...a) => courierDeps.fetchImpl(...a),
    ...extra
  });

const parcel = {
  orderRefNumber: '1042',
  invoicePayment: 5200,
  orderDetail: 'Lawn Suit (M) x2',
  customerName: 'Sana Khan',
  customerPhone: '03001234567',
  deliveryAddress: 'House 5, Gulberg, Lahore',
  transactionNotes: 'Gift pack',
  cityName: 'LAHORE',
  items: 2,
  pickupAddressCode: '001 - LHR'
};

test('signs in in two steps, and once for many calls until the token expires', async () => {
  const calls = fakeTcs();
  const api = adapter();
  await api.cities();
  await api.addresses();
  const first = calls.filter(c => c.path === '/auth/api/auth');
  const second = calls.filter(c => c.path === '/ecom/api/authentication/token');
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(first[0].query.clientid, CREDS.clientId);
  assert.equal(second[0].query.username, CREDS.username);
  assert.equal(second[0].auth, 'Bearer bearer-1', 'the second step carries the first token');
  const later = calls.filter(c => c.path === '/ecom/api/setup/citylistbycountry');
  assert.equal(later[0].auth, 'Bearer bearer-1');
  assert.equal(later[0].query.accesstoken, 'access-1');
});

test('an expired token signs in again; a rejected one is retried once with a fresh sign-in', async () => {
  let calls = fakeTcs({ expiry: new Date(Date.now() + 10_000).toISOString() });
  await adapter().cities();
  await adapter().cities();
  assert.equal(
    calls.filter(c => c.path === '/auth/api/auth').length,
    2,
    'already inside the early-refresh window'
  );

  clearTcsSessions();
  calls = fakeTcs({ rejectOnce: true });
  const names = await adapter().addresses();
  assert.equal(names[0].addressCode, '001 - LHR');
  assert.equal(calls.filter(c => c.path === '/auth/api/auth').length, 2);
});

test('a wrong client id says so in plain words and never repeats the secret', async () => {
  fakeTcs({ badClient: true });
  await assert.rejects(
    () => adapter().cities(),
    err => {
      assert.ok(err instanceof CourierError);
      assert.match(err.message, /client id and secret/);
      assert.ok(!err.message.includes(CREDS.clientSecret));
      assert.ok(!err.message.includes(CREDS.password));
      return true;
    }
  );
  assert.throws(() => createTcs({ token: '' }), /no TCS sign-in details/);
  assert.throws(() => createTcs({ token: JSON.stringify({ clientId: '1' }) }), /incomplete/);
});

test('cities are TCS’s own spellings and cost centers become pickup choices', async () => {
  fakeTcs();
  const api = adapter();
  assert.deepEqual(await api.cities(), ['KARACHI', 'LAHORE']);
  assert.deepEqual(await api.addresses(), [
    {
      addressCode: '001 - LHR',
      address: 'Agrics Town, Raiwind Road, Lahore',
      cityName: 'LAHORE',
      contactPersonName: 'Shop Lahore'
    }
  ]);
  await assert.rejects(() => adapter({ account: '' }).addresses(), /account number/);
});

test('a booking carries the shipper from the cost center, the consignee, COD and the documented limits', async () => {
  const calls = fakeTcs();
  const made = await adapter().createOrder(parcel);
  assert.equal(made.trackingNumber, '99210301520');
  const sent = calls.find(c => c.path === '/ecom/api/booking/create').body;
  assert.equal(sent.accesstoken, 'access-1');
  assert.equal(sent.shipperinfo.tcsaccount, '04011K1');
  assert.equal(sent.shipperinfo.shippername, 'Shop Lahore');
  assert.equal(sent.shipperinfo.mobile, '03447274889');
  assert.equal(sent.shipperinfo.cityname, 'LAHORE');
  assert.equal(sent.consigneeinfo.firstname, 'Sana');
  assert.equal(sent.consigneeinfo.mobile, '03001234567');
  assert.equal(sent.consigneeinfo.cityname, 'LAHORE');
  assert.equal(sent.consigneeinfo.countrycode, 'PK');
  assert.equal(sent.shipmentinfo.costcentercode, '001 - LHR');
  assert.equal(sent.shipmentinfo.referenceno, '1042');
  assert.equal(sent.shipmentinfo.servicecode, 'O');
  assert.equal(sent.shipmentinfo.codamount, 5200);
  assert.equal(sent.shipmentinfo.weightinkg, 0.5);
  assert.equal(sent.shipmentinfo.pieces, 2);
  assert.equal(sent.shipmentinfo.fragile, false);
  assert.equal(sent.shipmentinfo.remarks, 'Gift pack');
  assert.equal(sent.shipmentinfo.skus[0].unitprice, 2600);
});

test('a booking over TCS’s COD limit, or to a cost center it does not have, is refused before sending', async () => {
  const calls = fakeTcs();
  await assert.rejects(
    () => adapter().createOrder({ ...parcel, invoicePayment: 250_001 }),
    /at most Rs 250,000/
  );
  await assert.rejects(
    () => adapter().createOrder({ ...parcel, pickupAddressCode: 'nope' }),
    /not on the TCS account/
  );
  assert.equal(
    calls.some(c => c.path === '/ecom/api/booking/create'),
    false
  );
});

test('TCS’s own error names are shown, and a prepaid parcel still carries a unit price of at least 1', async () => {
  fakeTcs({ bookError: 'Consignee address is too short' });
  await assert.rejects(
    () => adapter().createOrder(parcel),
    /TCS says: Consignee address is too short/
  );
  const calls = fakeTcs();
  await adapter().createOrder({ ...parcel, invoicePayment: 0 });
  assert.equal(
    calls.find(c => c.path === '/ecom/api/booking/create').body.shipmentinfo.skus[0].unitprice,
    1
  );
});

test('names and addresses are cut to TCS’s fields', () => {
  assert.deepEqual(splitName('Sana Khan'), { firstname: 'Sana', middlename: 'Khan', lastname: '' });
  assert.deepEqual(splitName('Muhammad Ali Raza Khan'), {
    firstname: 'Muhammad',
    middlename: 'Ali',
    lastname: 'Raza Khan'
  });
  assert.equal(splitName('Al').firstname, 'Al', 'a short name is sent whole rather than blank');
  const lines = addressLines('a'.repeat(300));
  assert.equal(lines.address1.length, 120);
  assert.equal(lines.address2.length, 120);
  assert.equal(lines.address3.length, 60);
});

test('tracking: OK is delivered, RO is returned, anything else keeps TCS’s own words', async () => {
  const step = (code, status) => ({
    consignmentno: 'A',
    station: 'LHE',
    datetime: 'x',
    status,
    code
  });
  const record = (code, status) => ({
    shipmentinfo: [{ consignmentno: 'A', referenceno: '1042', destination: 'LAHORE' }],
    deliveryinfo: [step(code, status)],
    checkpoints: [{ status: 'Out For Delivery' }, { status: 'Arrived at TCS Facility' }],
    message: 'SUCCESS'
  });
  fakeTcs({
    tracking: {
      D: record('OK', 'Delivered'),
      R: record('RO', 'Return To Origin'),
      M: record('SC', 'Awaiting Receiver Collection')
    }
  });
  const api = adapter();
  const delivered = await api.track('D');
  assert.equal(delivered.status, 'Delivered');
  assert.equal(readStatus(delivered), 'delivered');
  assert.equal(readStatus(await api.track('R')), 'returned');
  const moving = await api.track('M');
  assert.equal(moving.status, 'Awaiting Receiver Collection');
  assert.equal(readStatus(moving), 'moving');
  assert.deepEqual(
    delivered.history.map(h => h.message),
    ['Arrived at TCS Facility', 'Out For Delivery'],
    'oldest first'
  );
  assert.equal(phaseOf(delivered), PHASES.DELIVERED);
  assert.equal(
    phaseOf({
      status: 'Awaiting Receiver Collection',
      history: [{ code: '', message: 'Arrived at TCS Facility' }]
    }),
    PHASES.UNKNOWN
  );
  assert.equal(phaseOf({ status: 'Arrived at TCS Facility' }), PHASES.AT_WAREHOUSE);
});

test('an unknown consignment is "not found", one parcel never hides the rest in a bulk check', async () => {
  fakeTcs({
    tracking: {
      A: {
        shipmentinfo: [{}],
        deliveryinfo: [{ code: 'OK', status: 'Delivered' }],
        checkpoints: []
      }
    }
  });
  const rows = await adapter().trackBulk(['A', 'ZZZ']);
  assert.equal(rows.find(r => r.trackingNumber === 'A').found, true);
  assert.equal(rows.find(r => r.trackingNumber === 'ZZZ').found, false);
});

test('cancel, payment status and airway bills (joined into one PDF)', async () => {
  const calls = fakeTcs({ paid: ['P1'] });
  const api = adapter();
  await api.cancel('99210301520');
  assert.deepEqual(
    calls.find(c => c.path === '/ecom/api/booking/cancel').body.consignmentNumber,
    '99210301520'
  );
  assert.equal((await api.paymentStatus('P1')).settled, true);
  assert.equal((await api.paymentStatus('P2')).settled, false);
  const pdf = await api.airwayBill(['A', 'B']);
  assert.equal((await PDFDocument.load(pdf)).getPageCount(), 2);
  await assert.rejects(() => api.loadSheet(), /load sheet/);
  assert.deepEqual(await api.unbooked({}), []);
});

test('sign-in details are saved encrypted, never shown again, and TCS starts with auto-confirm OFF', async () => {
  const biz = await makeBusiness({ name: 'TCS Shop' });
  const party = await makeParty(biz._id, 'courier');
  const out = await runHandler(saveConnection, {
    user: admin,
    resource: party,
    body: courierConnectionSchema.parse({
      provider: 'tcs',
      credentials: CREDS,
      accountNumber: '04011K1',
      pickupAddressCode: '001 - LHR'
    })
  });
  const view = out.body.data;
  assert.equal(view.provider, 'tcs');
  assert.equal(view.hasToken, true);
  assert.equal(view.accountNumber, '04011K1');
  assert.equal(view.autoConfirm, false);
  assert.ok(!JSON.stringify(out.body).includes(CREDS.password));
  assert.ok(!JSON.stringify(out.body).includes(CREDS.clientSecret));

  const stored = await Party.findById(party._id).select('+integration.tokenEnc');
  assert.ok(!stored.integration.tokenEnc.includes(CREDS.password));
  fakeTcs();
  const { api, provider } = await adapterFor(party._id, { requireEnabled: false });
  assert.equal(provider, 'tcs');
  assert.deepEqual(await api.cities(), ['KARACHI', 'LAHORE']);

  const read = await runHandler(getConnection, {
    user: admin,
    resource: await Party.findById(party._id)
  });
  assert.ok(!JSON.stringify(read.body).includes(CREDS.clientId + CREDS.password));
});

test('TCS takes four sign-in values, PostEx a key — the wrong kind is refused; TCS payments are never auto-recorded', async () => {
  const biz = await makeBusiness({ name: 'Mixed Shop' });
  const tcs = await makeParty(biz._id, 'courier');
  await runHandler(saveConnection, {
    user: admin,
    resource: tcs,
    body: courierConnectionSchema.parse({ provider: 'tcs', credentials: CREDS })
  });
  const saved = await Party.findById(tcs._id);
  await assert.rejects(
    () =>
      runHandler(saveConnection, {
        user: admin,
        resource: saved,
        body: courierConnectionSchema.parse({ token: 'a-long-enough-key' })
      }),
    /client id, secret, username and password/
  );
  await assert.rejects(
    () =>
      runHandler(saveConnection, {
        user: admin,
        resource: saved,
        body: courierConnectionSchema.parse({ recordPayments: true })
      }),
    /entered from its invoice/
  );
  const px = await makeParty(biz._id, 'courier');
  await assert.rejects(
    () =>
      runHandler(saveConnection, {
        user: admin,
        resource: px,
        body: courierConnectionSchema.parse({ provider: 'postex', credentials: CREDS })
      }),
    /Only TCS/
  );
});
