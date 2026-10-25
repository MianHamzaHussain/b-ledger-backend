import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, oid } from './helpers/db.js';
import User from '../models/User.js';
import { createPresence, touchActive, resetTouchThrottle } from '../utils/presence.js';

/**
 * Online = a live connection; a refresh or a flaky network must not blink the person offline, two
 * tabs count once, and "last active" is written at most once a minute.
 */
before(connect);
after(disconnect);
afterEach(async () => {
  resetTouchThrottle();
  await clear();
});

const wait = ms => new Promise(r => setTimeout(r, ms));

const make = (graceMs = 30) => {
  const events = [];
  const presence = createPresence({ onChange: e => events.push(e), graceMs });
  return { presence, events };
};

test('the first connection puts a person online, once', () => {
  const { presence, events } = make();
  presence.connect('u1');
  presence.connect('u1'); // a second tab
  assert.deepEqual(events, [{ userId: 'u1', online: true }]);
  assert.deepEqual(presence.onlineIds(), ['u1']);
});

test('closing one of two tabs keeps them online; closing the last goes offline after the grace', async () => {
  const { presence, events } = make(30);
  presence.connect('u1');
  presence.connect('u1');
  presence.disconnect('u1');
  await wait(60);
  assert.equal(events.length, 1, 'still just the online event');

  presence.disconnect('u1');
  assert.deepEqual(presence.onlineIds(), ['u1'], 'still online during the grace period');
  await wait(60);
  assert.equal(events.length, 2);
  assert.equal(events[1].online, false);
  assert.ok(events[1].lastActiveAt instanceof Date);
  assert.deepEqual(presence.onlineIds(), []);
});

test('a reconnect inside the grace period never shows as a change', async () => {
  const { presence, events } = make(50);
  presence.connect('u1');
  presence.disconnect('u1'); // page refresh
  await wait(10);
  presence.connect('u1');
  await wait(90);
  assert.equal(events.length, 1, 'no offline, no second online');
  assert.deepEqual(presence.onlineIds(), ['u1']);
});

test('last active is written at most once a minute, and not as a profile edit', async () => {
  const id = oid();
  await User.collection.insertOne({
    _id: id,
    name: 'Ali',
    updatedAt: new Date('2026-01-01')
  });

  touchActive(id, 1_000_000);
  touchActive(id, 1_000_000 + 30_000); // inside the minute: no write
  await wait(100);
  const first = await User.collection.findOne({ _id: id });
  assert.equal(first.lastActiveAt.getTime(), 1_000_000);
  assert.equal(first.updatedAt.getTime(), new Date('2026-01-01').getTime(), 'not an edit');

  touchActive(id, 1_000_000 + 61_000);
  await wait(100);
  assert.equal((await User.collection.findOne({ _id: id })).lastActiveAt.getTime(), 1_061_000);
});
