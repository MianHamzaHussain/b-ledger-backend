import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { encryptSecret } from '../utils/secretBox.js';
import { assertTestDatabase } from './helpers/db.js';

/**
 * Test and demo settings must never reach a real server or a real database: the demo stand-in for the
 * courier refuses to boot in production, the test suite refuses any database that is not plainly a test
 * one, and a wrong courier key says it is wrong rather than "missing".
 */
const boot = env =>
  spawnSync(process.execPath, ['config/env.js'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, MONGODB_URI: 'mongodb://x/y', JWT_SECRET: 's', ...env }
  });

test('the demo courier address and fast status check are refused in production', () => {
  for (const demo of [
    { POSTEX_BASE_URL: 'http://localhost:5099' },
    { COURIER_SYNC_SECONDS: '10' }
  ]) {
    const out = boot({ NODE_ENV: 'production', ...demo });
    assert.equal(out.status, 1, JSON.stringify(demo));
    assert.match(out.stderr, /must not be set in production/);
  }
});

test('outside production the demo courier address starts, with a loud warning', () => {
  const out = boot({ NODE_ENV: 'development', POSTEX_BASE_URL: 'http://localhost:5099' });
  assert.equal(out.status, 0);
  assert.match(out.stderr, /Demo mode: courier calls go to http:\/\/localhost:5099/);
});

test('a normal production boot is untouched', () => {
  assert.equal(boot({ NODE_ENV: 'production' }).status, 0);
});

test('a courier key that is set but wrong is called wrong at boot', () => {
  const out = boot({
    NODE_ENV: 'production',
    COURIER_SECRET_KEY: 'not-hex-'.repeat(4)
  });
  assert.equal(out.status, 0);
  assert.match(out.stderr, /COURIER_SECRET_KEY is set but not valid/);
});

test('tests refuse any database that is not plainly a test one', () => {
  assert.doesNotThrow(() => assertTestDatabase('mongodb://127.0.0.1:27017/b_ledger_test'));
  assert.doesNotThrow(() =>
    assertTestDatabase('mongodb://u:p@host:27017/ci_test?retryWrites=true')
  );
  for (const real of [
    'mongodb://127.0.0.1:27017/bledger',
    'mongodb://u:p@vps:27017/b_ledger?authSource=admin',
    'mongodb://127.0.0.1:27017'
  ]) {
    assert.throws(() => assertTestDatabase(real), /Refusing to run tests against database/);
  }
});

test('the courier key says whether it is missing or wrong', () => {
  const keep = process.env.COURIER_SECRET_KEY;
  try {
    delete process.env.COURIER_SECRET_KEY;
    assert.throws(() => encryptSecret('k'), /COURIER_SECRET_KEY is missing/);
    process.env.COURIER_SECRET_KEY = 'Z'.repeat(64);
    assert.throws(() => encryptSecret('k'), /set but not valid.*64 characters.*0-9 and a-f/);
  } finally {
    if (keep === undefined) delete process.env.COURIER_SECRET_KEY;
    else process.env.COURIER_SECRET_KEY = keep;
  }
});
