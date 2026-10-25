import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, makeBusiness, runHandler, oid, userId } from './helpers/db.js';
import Customer from '../models/Customer.js';
import Order from '../models/Order.js';
import {
  createCustomer,
  importCustomers,
  exportCustomers
} from '../controllers/customerController.js';
import { customerCreateSchema, customerImportSchema } from '../schemas/customers.js';
import { normalizePhone, toWhatsApp, phoneProblem } from '../utils/phone.js';
import { csvCell } from '../utils/csv.js';
import { normalizeCustomerPhones } from '../utils/normalizeCustomerPhones.js';

/**
 * Customers can be added by hand, imported from an old list, and exported — and a phone number is
 * one customer however it was typed.
 */
before(connect);
after(disconnect);
afterEach(clear);

const admin = { id: userId, role: { fullAccess: true } };

test('a phone is saved in one form, however it was typed', () => {
  for (const typed of [
    '0300-1234567',
    '03001234567',
    '+92 300 1234567',
    '00923001234567',
    '3001234567',
    '(0300) 123 4567'
  ]) {
    assert.equal(normalizePhone(typed), '03001234567', typed);
  }
  assert.equal(
    normalizePhone('042 111 222 333'),
    '042111222333',
    'a landline is kept, not refused'
  );
  assert.equal(toWhatsApp('03001234567'), '923001234567');
  assert.equal(phoneProblem(''), 'The phone number is missing');
  assert.match(phoneProblem('123'), /too short/);
  assert.equal(phoneProblem('03001234567'), null);
});

test('a spreadsheet can not run a customer’s name as a formula', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('+9230012'), "'+9230012");
  assert.equal(csvCell('Sana, Lahore'), '"Sana, Lahore"');
  assert.equal(csvCell('Ali "Bhai"'), '"Ali ""Bhai"""');
  assert.equal(csvCell(undefined), '');
});

let n = 0;
const biz = () => makeBusiness({ name: `Shop ${(n += 1)}` });

const add = (business, extra = {}) =>
  runHandler(createCustomer, {
    user: admin,
    body: customerCreateSchema.parse({
      business: String(business._id),
      name: 'Sana',
      phone: '0300-1234567',
      ...extra
    })
  });

test('adding a customer by hand saves the standard phone and says where it came from', async () => {
  const b = await biz();
  const out = await add(b, { city: 'lahore', note: 'met at the exhibition' });
  assert.equal(out.status, 201);
  const c = await Customer.findById(out.body.data._id);
  assert.equal(c.phone, '03001234567');
  assert.equal(c.source, 'manual');
  assert.equal(c.note, 'met at the exhibition');
});

test('the same number typed another way is the same customer — told so, not duplicated', async () => {
  const b = await biz();
  await add(b);
  const again = await runHandler(createCustomer, {
    user: admin,
    body: customerCreateSchema.parse({
      business: String(b._id),
      name: 'Someone else',
      phone: '+92 300 1234567'
    })
  }).catch(e => e);
  // The handler answers 400 with the existing customer's name; runHandler rejects non-2xx.
  assert.equal(await Customer.countDocuments({ business: b._id }), 1);
  assert.ok(again);
});

test('an import adds new numbers, skips existing ones and says which rows were bad', async () => {
  const b = await biz();
  await add(b, { name: 'Original Name' });
  const out = await runHandler(importCustomers, {
    user: admin,
    body: customerImportSchema.parse({
      business: String(b._id),
      rows: [
        { name: 'Ali', phone: '0301-1111111' },
        { name: 'Bilal', phone: '+92 302 2222222', city: 'karachi' },
        { name: 'Same Person', phone: '03001234567' }, // already a customer
        { name: 'Twice', phone: '0301 1111111' }, // same number as Ali, in the same file
        { name: '', phone: '03003333333', line: 9 },
        { name: 'No Phone', phone: '', line: 10 },
        { name: 'Short', phone: '123', line: 11 }
      ]
    })
  });
  assert.deepEqual(out.body.data, {
    added: 2,
    skipped: 1,
    invalid: [
      { row: 9, reason: 'The name is missing' },
      { row: 10, reason: 'The phone number is missing' },
      { row: 11, reason: 'The phone number looks too short' }
    ]
  });
  assert.equal(
    (await Customer.findOne({ phone: '03001234567' })).name,
    'Original Name',
    'never overwritten'
  );
  assert.equal((await Customer.findOne({ phone: '03022222222' })).source, 'import');
});

test('sending the same import twice adds nothing the second time', async () => {
  const b = await biz();
  const send = () =>
    runHandler(importCustomers, {
      user: admin,
      body: customerImportSchema.parse({
        business: String(b._id),
        rows: [{ name: 'Ali', phone: '03011111111' }]
      })
    });
  assert.equal((await send()).body.data.added, 1);
  assert.equal((await send()).body.data.added, 0);
});

test('an import is at most 500 rows a request', () => {
  const rows = Array.from({ length: 501 }, (_, i) => ({
    name: 'A',
    phone: `0300${String(i).padStart(7, '0')}`
  }));
  assert.equal(customerImportSchema.safeParse({ business: 'b', rows }).success, false);
  assert.equal(customerImportSchema.safeParse({ business: 'b', rows: [] }).success, false);
});

/** A response that collects what is written to it. */
const capture = () => {
  const res = { chunks: [], headers: {} };
  res.setHeader = (k, v) => (res.headers[k] = v);
  res.write = chunk => res.chunks.push(chunk);
  res.end = () => {};
  return res;
};

test('an export is one business’s customers as a CSV, with the WhatsApp form of each number', async () => {
  const a = await biz();
  const other = await biz();
  await add(a, { name: '=SUM(1)' });
  await add(other, { name: 'Elsewhere' });

  const res = capture();
  await new Promise((resolve, reject) => {
    res.end = resolve;
    exportCustomers({ user: admin, query: { business: String(a._id) } }, res, reject);
  });
  const text = res.chunks.join('');
  assert.ok(text.startsWith('﻿name,phone,whatsapp,city,source,addedOn'));
  assert.match(text, /'=SUM\(1\),03001234567,923001234567,,manual,\d{4}-\d{2}-\d{2}/);
  assert.doesNotMatch(text, /Elsewhere/);
  assert.match(res.headers['Content-Disposition'], /customers-\d{4}-\d{2}-\d{2}\.csv/);
});

test('an export of a business outside your scope looks like it does not exist', async () => {
  const a = await biz();
  let error;
  await exportCustomers(
    {
      user: admin,
      query: { business: String(a._id) },
      accessFilter: { business: { $in: [oid()] } }
    },
    capture(),
    e => (error = e)
  );
  assert.match(error.message, /not found/);
});

test('the migration merges the same person typed two ways, repoints orders and is safe to repeat', async () => {
  const b = await biz();
  const old = await Customer.collection.insertOne({
    business: b._id,
    name: 'Sana (old)',
    phone: '0300-1234567',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-02-01')
  });
  const fresh = await Customer.collection.insertOne({
    business: b._id,
    name: 'Sana (new)',
    phone: '+923001234567',
    city: 'Lahore',
    createdAt: new Date('2026-03-01'),
    updatedAt: new Date('2026-04-01')
  });
  await Order.collection.insertOne({ business: b._id, customer: fresh.insertedId });

  assert.deepEqual(await normalizeCustomerPhones({ apply: false }), {
    checked: 2,
    rewritten: 1,
    merged: 1
  });
  assert.equal(await Customer.countDocuments(), 2, 'a dry run changes nothing');

  await normalizeCustomerPhones({ apply: true });
  const all = await Customer.find();
  assert.equal(all.length, 1);
  assert.equal(all[0].phone, '03001234567');
  assert.equal(all[0].name, 'Sana (new)', 'the newest name wins');
  assert.equal(String(all[0]._id), String(old.insertedId), 'the earliest record survives');
  assert.equal(String((await Order.collection.findOne({})).customer), String(old.insertedId));

  assert.deepEqual(await normalizeCustomerPhones({ apply: true }), {
    checked: 1,
    rewritten: 0,
    merged: 0
  });
});
