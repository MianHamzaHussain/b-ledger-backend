import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pakistanDay,
  startOfPakistanDay,
  endOfPakistanDay,
  parseBusinessDate
} from '../utils/pakistanDay.js';

/**
 * Days are Pakistan days (UTC+5) on a UTC server. The instants below are fixed, so these pass
 * under any TZ the machine runs in.
 */
test('the day flips at Pakistan midnight, not UTC midnight', () => {
  assert.equal(pakistanDay(new Date('2026-10-23T18:59:00Z')), '2026-10-23');
  assert.equal(pakistanDay(new Date('2026-10-23T19:01:00Z')), '2026-10-24');
  assert.equal(pakistanDay(new Date('2026-10-22T20:00:00Z')), '2026-10-23'); // 01:00 PKT
});

test('a day runs from 00:00 to 23:59:59.999 Pakistan time', () => {
  assert.equal(startOfPakistanDay('2026-09-02').toISOString(), '2026-09-01T19:00:00.000Z');
  assert.equal(endOfPakistanDay('2026-09-02').toISOString(), '2026-09-02T18:59:59.999Z');
});

test('a bare date means that Pakistan day — start for a from, end for an inclusive to', () => {
  assert.equal(parseBusinessDate('2026-10-25').toISOString(), '2026-10-24T19:00:00.000Z');
  assert.equal(parseBusinessDate('2026-10-25', 'end').toISOString(), '2026-10-25T18:59:59.999Z');
});

test('a full timestamp or a Date is used as given', () => {
  assert.equal(
    parseBusinessDate('2026-10-25T10:00:00.000Z').toISOString(),
    '2026-10-25T10:00:00.000Z'
  );
  const d = new Date('2026-10-25T10:00:00Z');
  assert.equal(parseBusinessDate(d), d);
});
