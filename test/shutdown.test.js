import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShutdown } from '../utils/shutdown.js';

/**
 * A restart must finish in seconds. A SIGTERM listener that merely stops a timer leaves the process
 * running until systemd kills it after 90 s (seen in production, every deploy). The shutdown runs its
 * steps in order, then EXITS — and exits anyway if a step hangs.
 */
const quietLog = { info() {}, error() {} };
const recorder = () => {
  const calls = [];
  return { calls, exit: code => calls.push(`exit:${code}`) };
};

test('runs every step in order, then exits cleanly', async () => {
  const { calls, exit } = recorder();
  const shutdown = createShutdown({
    log: quietLog,
    exit,
    steps: [
      () => calls.push('timers'),
      async () => calls.push('http'),
      () => calls.push('database')
    ]
  });
  await shutdown('SIGTERM');
  assert.deepEqual(calls, ['timers', 'http', 'database', 'exit:0']);
});

test('a step that fails does not stop the rest — the database is still closed', async () => {
  const { calls, exit } = recorder();
  let logged = 0;
  const shutdown = createShutdown({
    log: { info() {}, error: () => (logged += 1) },
    exit,
    steps: [
      () => {
        throw new Error('boom');
      },
      () => calls.push('database')
    ]
  });
  await shutdown('SIGTERM');
  assert.deepEqual(calls, ['database', 'exit:0']);
  assert.equal(logged, 1);
});

test('a step that never finishes can not hold the restart: it exits anyway, with an error code', async () => {
  const { calls, exit } = recorder();
  const shutdown = createShutdown({
    log: quietLog,
    exit,
    timeoutMs: 30,
    steps: [() => new Promise(() => {})] // a connection that never closes
  });
  void shutdown('SIGTERM');
  await new Promise(r => setTimeout(r, 120));
  assert.deepEqual(calls, ['exit:1']);
});

test('asked twice (SIGTERM then Ctrl+C), it still runs once', async () => {
  const { calls, exit } = recorder();
  const shutdown = createShutdown({ log: quietLog, exit, steps: [() => calls.push('step')] });
  await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);
  assert.deepEqual(calls, ['step', 'exit:0']);
});

test('a clean shutdown does not leave the give-up timer to fire later', async () => {
  const { calls, exit } = recorder();
  const shutdown = createShutdown({ log: quietLog, exit, timeoutMs: 40, steps: [] });
  await shutdown('SIGTERM');
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(calls, ['exit:0'], 'no second, failing exit');
});
