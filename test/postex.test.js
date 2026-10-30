import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPostex } from '../utils/couriers/postex.js';
import { CourierError } from '../utils/couriers/courierError.js';

/**
 * The PostEx adapter against a fake service: the right URL, header and body for every call in the
 * guide, PostEx's answers turned into plain values, and every failure into a message a person can
 * act on. Nothing here can reach (or book a parcel on) the real PostEx.
 */
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const fake = replies => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchImpl, calls };
};

const px = replies => {
  const f = fake(replies);
  return { ...f, api: createPostex({ token: 'secret-key', fetchImpl: f.fetchImpl }) };
};

test('every call carries the key in the token header', async () => {
  const { api, calls } = px([json({ statusCode: '200', dist: [] })]);
  await api.addresses();
  assert.equal(calls[0].headers.token, 'secret-key');
});

test('there is no adapter without a key', () => {
  assert.throws(() => createPostex({ token: '' }), /no PostEx key/);
});

test('cities: the names PostEx delivers to', async () => {
  const { api, calls } = px([
    json({
      statusCode: '200',
      dist: [{ operationalCityName: 'Lahore' }, { operationalCityName: 'Multan' }]
    })
  ]);
  assert.deepEqual(await api.cities(), ['Lahore', 'Multan']);
  assert.match(calls[0].url, /get-operational-city\?operationalCityType=delivery$/);
});

test('addresses: the pickup codes', async () => {
  const { api } = px([
    json({
      statusCode: '200',
      dist: [
        {
          addressCode: '001',
          address: 'Shop 4',
          cityName: 'Lahore',
          contactPersonName: 'Ali',
          phone1: 'x'
        }
      ]
    })
  ]);
  assert.deepEqual(await api.addresses(), [
    { addressCode: '001', address: 'Shop 4', cityName: 'Lahore', contactPersonName: 'Ali' }
  ]);
});

test('createOrder posts the parcel once and returns the tracking number', async () => {
  const { api, calls } = px([
    json({
      statusCode: '200',
      dist: { trackingNumber: 'CX-123', orderStatus: 'UnBooked', orderDate: '2026-10-26' }
    })
  ]);
  const out = await api.createOrder({ orderRefNumber: '0042', invoicePayment: 4500 });
  assert.equal(out.trackingNumber, 'CX-123');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].url, /order\/v3\/create-order$/);
  assert.deepEqual(JSON.parse(calls[0].body), { orderRefNumber: '0042', invoicePayment: 4500 });
});

test('a create that fails on the network is NOT retried — it could have made a parcel', async () => {
  const { api, calls } = px([
    new TypeError('socket hang up'),
    json({ statusCode: '200', dist: { trackingNumber: 'CX-9' } })
  ]);
  await assert.rejects(api.createOrder({}), /could not be reached/);
  assert.equal(calls.length, 1);
});

test('a read is retried once after a network blip', async () => {
  const { api, calls } = px([new TypeError('reset'), json({ statusCode: '200', dist: [] })]);
  assert.deepEqual(await api.cities(), []);
  assert.equal(calls.length, 2);
});

test('PostEx’s own refusal is shown in its words', async () => {
  const { api } = px([json({ statusCode: '400', statusMessage: 'Invalid city name' }, 400)]);
  await assert.rejects(api.createOrder({}), err => {
    assert.ok(err instanceof CourierError);
    assert.equal(err.message, 'PostEx says: Invalid city name');
    assert.equal(err.statusCode, 502);
    return true;
  });
});

test('a rejected key says so plainly', async () => {
  const { api } = px([new Response('', { status: 401 })]);
  await assert.rejects(api.addresses(), /did not accept the saved key/);
});

test('a PostEx server error is retryable and says to try later', async () => {
  const { api } = px([json({}, 500), json({}, 500)]);
  await assert.rejects(api.cities(), /having trouble right now/);
});

test('a created parcel with no tracking number is an error, not a blank', async () => {
  const { api } = px([json({ statusCode: '200', dist: {} })]);
  await assert.rejects(api.createOrder({}), /no tracking number/);
});

test('track: the status, the fees and the journey', async () => {
  const { api, calls } = px([
    json({
      statusCode: '200',
      dist: {
        trackingNumber: 'CX-1',
        orderRefNumber: '0042',
        transactionStatus: 'Delivered',
        transactionFee: '180',
        transactionTax: 29,
        reversalFee: 0,
        invoicePayment: 4500,
        transactionStatusHistory: [
          {
            transactionStatusMessage: "At Merchant's Warehouse",
            transactionStatusMessageCode: '0001'
          },
          { transactionStatusMessage: 'Delivered', transactionStatusMessageCode: '0005' }
        ]
      }
    })
  ]);
  const t = await api.track('CX-1');
  assert.equal(t.status, 'Delivered');
  assert.equal(t.fee, 180);
  assert.equal(t.tax, 29);
  assert.deepEqual(
    t.history.map(h => h.code),
    ['0001', '0005']
  );
  assert.match(calls[0].url, /track-order\/CX-1$/);
});

test('trackBulk: several parcels in one call, comma-separated', async () => {
  const { api, calls } = px([
    json({
      statusCode: '200',
      dist: [
        {
          trackingNumber: 'CX-1',
          message: 'SUCCESSFULLY RETRIEVE ORDER',
          trackingResponse: { transactionStatus: 'Booked', trackingNumber: 'CX-1' }
        },
        { trackingNumber: 'CX-2', message: 'ORDER NOT FOUND', trackingResponse: null }
      ]
    })
  ]);
  const rows = await api.trackBulk(['CX-1', 'CX-2']);
  assert.match(calls[0].url, /track-bulk-order\?TrackingNumbers=CX-1%2CCX-2$/);
  assert.equal(rows[0].status, 'Booked');
  assert.equal(rows[0].found, true);
  assert.equal(rows[1].found, false);
});

test('airwayBill returns the PDF bytes, at most 10 numbers', async () => {
  const pdf = new Response(Buffer.from('%PDF-1.4 fake'), {
    status: 200,
    headers: { 'Content-Type': 'application/pdf' }
  });
  const { api, calls } = px([pdf]);
  const numbers = Array.from({ length: 12 }, (_, i) => `CX-${i}`);
  const out = await api.airwayBill(numbers);
  assert.ok(Buffer.isBuffer(out));
  assert.match(out.toString(), /^%PDF/);
  assert.equal(new URL(calls[0].url).searchParams.get('trackingNumbers').split(',').length, 10);
});

test('cancel and payment status use the documented paths', async () => {
  const { api, calls } = px([
    json({ statusCode: '200' }),
    json({ statusCode: '200', dist: { settle: true, settlementDate: '2026-10-28' } })
  ]);
  await api.cancel('CX-1');
  assert.equal(calls[0].method, 'PUT');
  assert.deepEqual(JSON.parse(calls[0].body), { trackingNumber: 'CX-1' });
  assert.deepEqual(await api.paymentStatus('CX-1'), {
    settled: true,
    settlementDate: '2026-10-28'
  });
});

test('shipper advice goes to the documented (singular "service") address', async () => {
  const { api, calls } = px([json({ statusCode: '200' })]);
  await api.shipperAdvice({
    trackingNumber: 'CX-1',
    statusId: 2,
    remarks: 'Customer will be home'
  });
  assert.match(calls[0].url, /\/service\/integration\/api\/order\/v2\/save-shipper-advice$/);
});

test('the key is never part of an error message', async () => {
  const { api } = px([json({ statusCode: '400', statusMessage: 'bad' }, 400)]);
  await assert.rejects(api.createOrder({}), err => !err.message.includes('secret-key'));
});

test('cities: a city PostEx lists but marks as not delivering (or not collecting) is left out', async () => {
  const dist = [
    { operationalCityName: 'Lahore', isDeliveryCity: 'true', isPickupCity: 'true' },
    { operationalCityName: 'Sehwan', isDeliveryCity: 'false', isPickupCity: 'true' },
    { operationalCityName: 'Quetta', isDeliveryCity: true, isPickupCity: false },
    { operationalCityName: 'Multan' }
  ];
  const delivery = px([json({ statusCode: '200', dist })]);
  assert.deepEqual(await delivery.api.cities('delivery'), ['Lahore', 'Quetta', 'Multan']);
  const pickup = px([json({ statusCode: '200', dist })]);
  assert.deepEqual(await pickup.api.cities('pickup'), ['Lahore', 'Sehwan', 'Multan']);
});
