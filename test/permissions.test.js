import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePermissions } from '../utils/permissions.js';

/**
 * The authorization resolver (§6.2). Pure logic, no DB. Mirrors the frontend's
 * usePermissions suite — the two are kept honest by matching tests, so a change
 * to one that isn't reflected here should break the other's behaviour.
 *
 * Note: `fullAccess` (admin bypass) is handled in `can()` before this resolver
 * ever runs, so it is not exercised here.
 */

const role = permissions => ({ role: { permissions } });

test('role grid grants exactly its listed actions', () => {
  const map = resolvePermissions(
    role([{ resource: 'orders', actions: ['read', 'create'], scope: 'own' }])
  );
  const orders = map.get('orders');
  assert.ok(orders.actions.has('read'));
  assert.ok(orders.actions.has('create'));
  assert.ok(!orders.actions.has('delete'));
  assert.equal(orders.scope, 'own');
});

test('a non-scopable resource is forced to scope "all"', () => {
  // `users` is registered non-scopable; a role asking for "own" still gets "all".
  const map = resolvePermissions(role([{ resource: 'users', actions: ['read'], scope: 'own' }]));
  assert.equal(map.get('users').scope, 'all');
});

test('a grant override adds actions on top of the role', () => {
  const user = {
    role: { permissions: [{ resource: 'reports', actions: ['read'], scope: 'own' }] },
    permissionOverrides: [
      { resource: 'reports', effect: 'grant', actions: ['create'], scope: 'own' }
    ]
  };
  const reports = resolvePermissions(user).get('reports');
  assert.ok(reports.actions.has('read'));
  assert.ok(reports.actions.has('create'));
});

test('a grant override to scope "all" widens the scope', () => {
  const user = {
    role: { permissions: [{ resource: 'orders', actions: ['read'], scope: 'own' }] },
    permissionOverrides: [
      { resource: 'orders', effect: 'deny', actions: [], scope: 'own' },
      { resource: 'orders', effect: 'grant', actions: ['read'], scope: 'all' }
    ]
  };
  assert.equal(resolvePermissions(user).get('orders').scope, 'all');
});

test('a deny override removes an action', () => {
  const user = {
    role: { permissions: [{ resource: 'orders', actions: ['read', 'delete'], scope: 'own' }] },
    permissionOverrides: [{ resource: 'orders', effect: 'deny', actions: ['delete'], scope: 'own' }]
  };
  const orders = resolvePermissions(user).get('orders');
  assert.ok(orders.actions.has('read'));
  assert.ok(!orders.actions.has('delete'));
});

test('denying the last action drops the resource entirely', () => {
  const user = {
    role: { permissions: [{ resource: 'orders', actions: ['read'], scope: 'own' }] },
    permissionOverrides: [{ resource: 'orders', effect: 'deny', actions: ['read'], scope: 'own' }]
  };
  assert.equal(resolvePermissions(user).get('orders'), undefined);
});

test('stale rows for unregistered resources are ignored', () => {
  const map = resolvePermissions(
    role([{ resource: 'not_a_real_resource', actions: ['read'], scope: 'own' }])
  );
  assert.equal(map.get('not_a_real_resource'), undefined);
});
