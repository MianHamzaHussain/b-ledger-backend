import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { ACTIONS, RESOURCES, RESOURCE_KEYS, getPermissionRegistry } from '../utils/permissions.js';

/**
 * Whoever makes a role is often not technical. Every area says, in plain words, what
 * it is and what each tick lets someone do — and those words must not drift from what
 * the routes really enforce, or the screen would promise access that does not exist
 * (or hide access that does).
 */

test('every area has a plain description and at least one phrase', () => {
  for (const key of RESOURCE_KEYS) {
    const { description, can } = RESOURCES[key];
    assert.ok(description && description.length >= 15, `${key} needs a description`);
    assert.ok(Object.keys(can || {}).length > 0, `${key} needs a phrase for what it allows`);
  }
});

test('phrases are only for real actions, and read as plain sentence fragments', () => {
  for (const key of RESOURCE_KEYS) {
    for (const [action, phrase] of Object.entries(RESOURCES[key].can)) {
      assert.ok(ACTIONS.includes(action), `${key}: "${action}" is not an action`);
      assert.ok(
        phrase.trim() === phrase && phrase.length >= 4,
        `${key}.${action} is empty or padded`
      );
      // The screen joins these after "Can:", so no capital start and no trailing full stop.
      assert.equal(
        phrase[0],
        phrase[0].toLowerCase(),
        `${key}.${action} should start in lower case`
      );
      assert.ok(!phrase.endsWith('.'), `${key}.${action} should not end with a full stop`);
    }
  }
});

test('the registry sent to the screen carries the descriptions', () => {
  const { resources } = getPermissionRegistry();
  assert.equal(resources.length, RESOURCE_KEYS.length);
  for (const r of resources) {
    assert.equal(r.description, RESOURCES[r.key].description);
    assert.deepEqual(r.can, RESOURCES[r.key].can);
  }
});

/** Every `can('resource', 'action')` / `requirePermission(...)` a route file uses. */
const routeRequirements = () => {
  const found = new Map();
  const dir = new URL('../routes/', import.meta.url);
  for (const file of readdirSync(dir).filter(f => f.endsWith('.js'))) {
    const text = readFileSync(new URL(file, dir), 'utf8');
    for (const [, resource, action] of text.matchAll(
      /(?:can|requirePermission)\(\s*'([A-Za-z]+)'\s*,\s*'([a-z]+)'/g
    )) {
      found.set(`${resource}:${action}`, file);
    }
  }
  return found;
};

test('every action a route requires has a description, so nothing is enforced but undescribed', () => {
  const missing = [];
  for (const [requirement, file] of routeRequirements()) {
    const [resource, action] = requirement.split(':');
    assert.ok(RESOURCES[resource], `${file} uses unknown resource "${resource}"`);
    if (!RESOURCES[resource].can?.[action]) missing.push(`${requirement} (in ${file})`);
  }
  assert.deepEqual(missing, [], `add a "can" phrase for: ${missing.join(', ')}`);
});

test('the scan really finds the routes (so the test above can not pass by finding nothing)', () => {
  const found = routeRequirements();
  assert.ok(found.size > 40, `only found ${found.size} requirements`);
  assert.ok(found.has('orders:update'));
  assert.ok(found.has('goodsReceipts:create'));
});

test('areas that can hand out access carry a warning', () => {
  assert.match(RESOURCES.users.description, /careful/i);
  assert.match(RESOURCES.roles.description, /careful/i);
  assert.match(RESOURCES.accounting.description, /only to someone who knows accounting/i);
});
