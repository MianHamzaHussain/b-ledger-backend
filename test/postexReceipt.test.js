import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  amountToPaisa,
  parsePostexReceipt,
  readPostexReceipt
} from '../utils/couriers/postexReceipt.js';

/**
 * PostEx's Cash Payment Receipt is the only record of what PostEx actually paid and charged, parcel by parcel. The
 * reader takes a PDF's text (with positions) and accepts it only if it adds up: every row against PostEx's own rule,
 * the rows against the printed totals. The fixtures are the real text of two receipts with the merchant's phone,
 * e-mail and address replaced — no PDF is kept in the repository.
 */
const load = name =>
  JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const qam = () => load('postex-cpr-qam.json');
const naksh = () => load('postex-cpr-naksh.json');

/** Change the text of the first item that says `from` (optionally on one page). */
const retype = (items, from, to, page) => {
  const hit = items.find(i => i.str === from && (page === undefined || i.page === page));
  assert.ok(hit, `fixture has "${from}"`);
  hit.str = to;
  return items;
};

test('amounts are read as text into paisa — never rounded, parentheses are negative', () => {
  assert.equal(amountToPaisa('13,171.75'), 1317175);
  assert.equal(amountToPaisa('(268.25)'), -26825);
  assert.equal(amountToPaisa('0.00'), 0);
  assert.equal(amountToPaisa('9.02'), 902);
  assert.equal(amountToPaisa('1,040.00'), 104000);
  assert.equal(amountToPaisa('12.5'), 1250);
  assert.equal(amountToPaisa('abc'), null);
  assert.equal(amountToPaisa(''), null);
});

test('the small receipt reads cleanly: a delivered parcel and a return', () => {
  const { receipt, problems } = parsePostexReceipt(naksh());
  assert.deepEqual(problems, []);
  assert.equal(receipt.cprNumber, 'CPR-XRFVS143882');
  assert.equal(receipt.cprDate, '2026-11-02');
  assert.equal(receipt.merchant, 'NAKSH PRETT');
  assert.equal(receipt.totals.netPaisa, 1290350);
  assert.equal(receipt.rows.length, 2);

  const [delivered, returned] = receipt.rows;
  assert.equal(delivered.tracking, '24707710000009');
  assert.equal(delivered.status, 'delivered');
  assert.equal(delivered.netPaisa, 1317175);
  assert.equal(returned.tracking, '23707710000008');
  assert.equal(returned.status, 'returned');
  assert.equal(returned.netPaisa, -26825);
});

test('the merchant’s own phone number is never mistaken for a parcel', () => {
  // The fixtures carry a phone number that looks like a tracking number; only real rows count.
  const { receipt } = parsePostexReceipt(naksh());
  assert.ok(
    naksh().some(i => i.str === '03000000000'),
    'the phone is in the fixture'
  );
  assert.ok(!receipt.rows.some(r => r.tracking === '03000000000'));
});

test('the large receipt: 71 parcels over five pages, adding up to PostEx’s own totals', () => {
  const { receipt, problems } = parsePostexReceipt(qam());
  assert.deepEqual(problems, []);
  assert.equal(receipt.cprNumber, 'CPR-XVITH110532');
  assert.equal(receipt.cprDate, '2026-11-04');
  assert.equal(receipt.merchant, 'QAM STYLE');
  assert.equal(receipt.rows.length, 71);
  assert.equal(receipt.rows.filter(r => r.status === 'delivered').length, 50);
  assert.equal(receipt.rows.filter(r => r.status === 'returned').length, 21);
  assert.deepEqual(receipt.totals, {
    netPaisa: 55884070,
    codPaisa: 60290000,
    shippingPaisa: 1719250,
    gstPaisa: 275080,
    deductionPaisa: 2411600,
    delivered: 50,
    returned: 21
  });
});

test('one delivered parcel, field by field', () => {
  const row = parsePostexReceipt(qam()).receipt.rows.find(r => r.tracking === '28703260000344');
  assert.deepEqual(row, {
    tracking: '28703260000344',
    status: 'delivered',
    orderedOn: '2026-10-22',
    doneOn: '2026-10-29',
    codPaisa: 1400000,
    shippingPaisa: 25350,
    upfrontChargesPaisa: 0,
    gstPaisa: 4056,
    deductionPaisa: 56000,
    netPaisa: 1314594
  });
});

test('a returned parcel on the last page, and a return’s COD column is not money', () => {
  const row = parsePostexReceipt(qam()).receipt.rows.find(r => r.tracking === '22703260000425');
  assert.equal(row.status, 'returned');
  assert.equal(row.netPaisa, -27898);
  assert.equal(row.deductionPaisa, 0);
  // The receipt prints the parcel's value (9,000.00) in that column, but no cash was collected.
  assert.equal(row.codPaisa, 900000);
  assert.equal(row.netPaisa, -(row.shippingPaisa + row.gstPaisa));
});

test('a delivered parcel with no cash to collect is read as a charge', () => {
  const rows = parsePostexReceipt(qam()).receipt.rows.filter(
    r => r.status === 'delivered' && r.codPaisa === 0
  );
  assert.deepEqual(rows.map(r => r.tracking).sort(), ['21703260000420', '24703260000410']);
  for (const r of rows) assert.equal(r.netPaisa, -29406);
});

test('a receipt with one figure changed by a paisa is refused, naming the parcel', () => {
  const items = qam();
  // Parcel 1's net on page 1: 13,145.94 → 13,145.95
  const net = items.find(i => i.page === 1 && i.str === '13,145.94');
  net.str = '13,145.95';
  const { receipt, problems } = parsePostexReceipt(items);
  assert.equal(receipt, null);
  assert.ok(
    problems.some(p => p.includes('28703260000344')),
    problems.join(' | ')
  );
});

test('a receipt with a parcel missing is refused: its count and totals no longer agree', () => {
  const items = qam();
  const tag = items.find(i => i.str === '22703260000425');
  // Remove that parcel's whole band (everything within its row on page 5).
  const gone = items.filter(i => i.page === tag.page && i.y <= tag.y + 2 && i.y >= tag.y - 16);
  const kept = items.filter(i => !gone.includes(i));
  const { receipt, problems } = parsePostexReceipt(kept);
  assert.equal(receipt, null);
  assert.ok(
    problems.some(p => /count|add up/i.test(p)),
    problems.join(' | ')
  );
});

test('a receipt with a carry-forward is refused rather than guessed at', () => {
  const items = qam();
  const label = items.find(i => i.page === 1 && i.str.trim() === 'Carry Forward');
  const value = items.find(i => i.page === 1 && Math.abs(i.y - label.y) < 6 && i.x > 500);
  value.str = '(100.00)';
  const { receipt, problems } = parsePostexReceipt(items);
  assert.equal(receipt, null);
  assert.ok(problems.some(p => /Carry forward/.test(p)));
});

test('text with no CPR number is not a receipt', () => {
  const items = naksh().filter(i => !i.str.startsWith('CPR-'));
  const { receipt, problems } = parsePostexReceipt(items);
  assert.equal(receipt, null);
  assert.ok(problems.some(p => /CPR number/.test(p)));
});

test('a row whose own figures break PostEx’s rule is refused', () => {
  const items = retype(naksh(), '560.00', '561.00', 1); // the delivered parcel's 4 % deduction
  const { receipt, problems } = parsePostexReceipt(items);
  assert.equal(receipt, null);
  assert.ok(
    problems.some(p => p.includes('24707710000009')),
    problems.join(' | ')
  );
});

test('bytes that are not a PDF are a problem, not a crash', async () => {
  const out = await readPostexReceipt(Buffer.from('not a pdf at all'));
  assert.equal(out.receipt, null);
  assert.deepEqual(out.problems, ['This file could not be read as a PDF']);
});
