import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BEFORE_DISPATCH,
  ORDER_STATUS,
  ORDER_TRANSITIONS,
  STOCK_HELD_STATUSES
} from '../utils/constants.js';
import { buildTimeline } from '../utils/orderActivity.js';

/**
 * "Created" is where every new order starts (waiting for the confirmation call); "Pending" is the order that was
 * called and not answered. Older orders that are Pending keep every exit they had.
 */
test('a created order can be confirmed, left pending, booked, dispatched or cancelled', () => {
  assert.deepEqual([...ORDER_TRANSITIONS.created].sort(), [
    'booked',
    'cancelled',
    'confirmed',
    'dispatched',
    'pending'
  ]);
});

test('a pending order keeps its old exits and does not go back to created', () => {
  assert.deepEqual([...ORDER_TRANSITIONS.pending].sort(), [
    'booked',
    'cancelled',
    'confirmed',
    'dispatched'
  ]);
});

test('a cancelled order is reopened as created — it needs a new call', () => {
  assert.deepEqual(ORDER_TRANSITIONS.cancelled, ['created']);
});

test('a created order holds stock and can still be edited, like any order before dispatch', () => {
  assert.ok(STOCK_HELD_STATUSES.includes('created'));
  assert.ok(BEFORE_DISPATCH.includes(ORDER_STATUS.CREATED));
  assert.ok(BEFORE_DISPATCH.includes(ORDER_STATUS.PENDING));
});

test('the timeline starts with "Order placed" whether the first status is created or an older pending', () => {
  const admin = { role: { fullAccess: true } };
  const at = new Date('2026-11-02T08:00:00Z');
  const fresh = buildTimeline(
    {
      statusHistory: [
        { status: 'created', at },
        { status: 'pending', at }
      ],
      activity: []
    },
    admin
  );
  const older = buildTimeline({ statusHistory: [{ status: 'pending', at }], activity: [] }, admin);

  const words = timeline => timeline.map(t => t.text).sort();
  assert.deepEqual(words(fresh), ['Order placed', 'Pending — no answer']);
  assert.deepEqual(words(older), ['Order placed']);
});
