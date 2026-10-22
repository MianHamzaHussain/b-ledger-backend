import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * bledger-uptime reads the minute-by-minute health log and reports availability,
 * outages, and gaps with no data. These tests feed it made-up logs and check what a
 * person would read, so the numbers can be trusted when something really goes wrong.
 *
 * The script is bash + awk. It runs on the server (Linux) and in CI; on Windows it is
 * skipped unless BASH_BIN points at a bash (for example Git Bash).
 */
const BASH = process.env.BASH_BIN || 'bash';
const SCRIPT = new URL('../ops/monitoring/bledger-uptime.sh', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1'
);
const runnable =
  (process.platform !== 'win32' || process.env.BASH_BIN) &&
  spawnSync(BASH, ['--version']).status === 0;
const t = (name, fn) => test(name, { skip: !runnable && 'bash is not available here' }, fn);

// 2026-10-23 00:00:00 UTC — an arbitrary fixed "now", so no test depends on the clock.
const NOW = Date.UTC(2026, 9, 23, 0, 0, 0) / 1000;
const stamp = secondsAgo => {
  // The server logs +02:00 local time; reproduce that so the offset handling is exercised.
  const d = new Date((NOW - secondsAgo + 2 * 3600) * 1000);
  return `${d.toISOString().slice(0, 19)}+02:00`;
};

/** A log with one line a minute for `minutes`, ending one minute before NOW. */
const logOf = (minutes, line = () => '200 0.010') =>
  Array.from({ length: minutes }, (_, i) => {
    const ago = (minutes - i) * 60;
    return `${stamp(ago)} ${line(i)}`;
  }).join('\n') + '\n';

const dir = mkdtempSync(path.join(tmpdir(), 'uptime-'));
let n = 0;
const run = (log, args = ['7']) => {
  const file = path.join(dir, `log-${(n += 1)}.log`).replace(/\\/g, '/');
  if (log !== null) writeFileSync(file, log);
  return spawnSync(BASH, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HEALTH_LOG: file, NOW_EPOCH: String(NOW) }
  });
};

t('a day with every check answered is 100% with nothing to report', () => {
  const r = run(logOf(24 * 60));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Checks:\s+1440 \(1440 answered, 0 did not\)/);
  assert.match(r.stdout, /Availability:\s+100\.000%/);
  assert.match(r.stdout, /Outages:\s+0/);
  assert.match(r.stdout, /No-data gaps:\s+0\n/);
});

t('an outage is found, with its length, and lowers availability', () => {
  // 100 checks, 5 of them (minutes 40–44) failing.
  const r = run(logOf(100, i => (i >= 40 && i < 45 ? '502 0.003' : '200 0.010')));
  assert.match(r.stdout, /Checks:\s+100 \(95 answered, 5 did not\)/);
  assert.match(r.stdout, /Outages:\s+1/);
  assert.match(r.stdout, /down for 5 min/);
  assert.match(r.stdout, /Availability:\s+95\.000%/);
  assert.match(r.stdout, /Downtime:\s+5 min/);
});

t('two separate outages are listed separately', () => {
  const r = run(logOf(120, i => (i === 10 || (i >= 60 && i < 63) ? '000 0' : '200 0.010')));
  assert.match(r.stdout, /Outages:\s+2/);
  assert.match(r.stdout, /down for 1 min/);
  assert.match(r.stdout, /down for 3 min/);
});

t('a hole in the log (server off) is reported as a gap and counted as downtime', () => {
  // 60 checks, then about 10 minutes with no line at all, then 50 more.
  const block = (fromMin, count) =>
    Array.from({ length: count }, (_, i) => `${stamp((fromMin - i) * 60)} 200 0.010`).join('\n');
  const r = run(block(120, 60) + '\n' + block(50, 50) + '\n');
  assert.match(r.stdout, /No-data gaps:\s+1\s+\(server off/);
  assert.match(r.stdout, /no checks for \d+ min/);
  assert.match(r.stdout, /Availability:\s+9\d\.\d{3}%/);
});

t('an outage that has not ended yet says STILL DOWN', () => {
  const r = run(logOf(30, i => (i >= 25 ? '000 0' : '200 0.010')));
  assert.match(r.stdout, /STILL DOWN/);
  assert.match(r.stdout, /Outages:\s+1/);
});

t('slow answers are counted and the slowest is shown', () => {
  const r = run(logOf(10, i => (i === 3 ? '200 4.500' : '200 0.010')));
  assert.match(r.stdout, /4\.500 s slowest, 1 over 2 s/);
});

t('only the last N days are read — older lines are ignored', () => {
  const old = `${stamp(10 * 86400)} 502 0.003\n`; // ten days ago, failing
  const r = run(old + logOf(60), ['7']);
  assert.match(r.stdout, /Checks:\s+60 \(60 answered, 0 did not\)/);
  const all = run(old + logOf(60), ['30']);
  assert.match(all.stdout, /Checks:\s+61 /);
});

t('a missing log explains what to do; bad input shows the usage', () => {
  const missing = run(null);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No health log/);

  assert.equal(run('x\n', ['abc']).status, 2);
  assert.equal(run('x\n', ['0']).status, 2);
  assert.match(run('x\n', ['abc']).stderr, /usage/);
});

t('a log with only junk, or nothing recent, says so instead of dividing by zero', () => {
  const r = run('not a log line\n');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /No checks in the last 7 day/);
});

test('cleanup', () => rmSync(dir, { recursive: true, force: true }));
