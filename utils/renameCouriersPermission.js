import Role from '../models/Role.js';
import User from '../models/User.js';

/**
 * The "couriers" permission became "integrations" (Round 11): the same switch now also covers connecting a store.
 * A role that still holds a `couriers` row would silently lose it — the permission resolver ignores a resource the
 * registry no longer knows — so every stored row is renamed once. Written against the raw collections because the
 * Role schema rightly refuses the old name.
 *
 * `apply: false` (the default) only counts. Safe to run twice: the second run finds nothing.
 */
export const renameCouriersPermission = async ({ apply = false } = {}) => {
  const roleFilter = { 'permissions.resource': 'couriers' };
  const userFilter = { 'permissionOverrides.resource': 'couriers' };

  const found = {
    roles: await Role.collection.countDocuments(roleFilter),
    users: await User.collection.countDocuments(userFilter)
  };
  if (!apply) return found;

  await Role.collection.updateMany(
    roleFilter,
    { $set: { 'permissions.$[p].resource': 'integrations' } },
    { arrayFilters: [{ 'p.resource': 'couriers' }] }
  );
  await User.collection.updateMany(
    userFilter,
    { $set: { 'permissionOverrides.$[o].resource': 'integrations' } },
    { arrayFilters: [{ 'o.resource': 'couriers' }] }
  );
  return found;
};
