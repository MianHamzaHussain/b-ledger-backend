import mongoose from 'mongoose';
import ErrorResponse from './errorResponse.js';
import Role from '../models/Role.js';
import { RESOURCES, resolvePermissions } from './permissions.js';
import { fullAccessRoleIds } from './fullAccessRoles.js';

/**
 * Delegated people and roles — what a Business Owner (or any non-admin who may manage users or roles) can see and
 * do. This is the ONE place the rules live, and the server applies them on every request: the screens hiding a
 * button is a courtesy, never the protection (root CLAUDE.md §4, §6).
 *
 *  R1  Own businesses only: a person they add or change is assigned only businesses they have themselves.
 *  R2  Visible people: someone whose businesses are ALL theirs, and who is not an Admin. Anyone else is a 404.
 *  R3  Ceiling: they can give only what they hold — every action, and no wider a scope.
 *  R4  Never delegated: Users, Roles and Accountant tools stay with an Admin.
 *  R5  Roles: the ones made for their own businesses (editable) and the ones an Admin marked `delegable` (usable).
 *  R6  Not themselves, and not another manager: no changing their own access or someone who can manage people.
 *
 * "Reach" is the scope on their Users / Roles permission: `own` (the businesses they are assigned to) or `all`
 * (an Admin-granted global manager). Admin (fullAccess) is unrestricted and never reaches this file's checks.
 */

/** Access an owner can never hand out — only an Admin makes another manager or opens the accounting tools. */
export const NEVER_DELEGATED = new Set(['users', 'roles', 'accounting']);

export const isAdmin = actor => Boolean(actor?.role?.fullAccess);

const idsOf = list => (list ?? []).map(b => String(b?._id ?? b));
const objectIds = list => idsOf(list).map(id => new mongoose.Types.ObjectId(id));

/** What the actor may reach for this resource ('users' or 'roles'): everything, or their own businesses. */
export const reachOf = (actor, resource) => {
  if (isAdmin(actor)) return { all: true, businesses: [] };
  const entry = resolvePermissions(actor).get(resource);
  return { all: entry?.scope === 'all', businesses: idsOf(actor?.assignedBusinesses) };
};

/** The filter that limits a list (or a lookup by id) of users to those the actor may see — R2. */
export const userVisibilityFilter = async actor => {
  const { all, businesses } = reachOf(actor, 'users');
  if (all) return {};
  const mine = objectIds(businesses);
  return {
    $and: [
      { assignedBusinesses: { $in: mine } },
      { assignedBusinesses: { $not: { $elemMatch: { $nin: mine } } } },
      { role: { $nin: await fullAccessRoleIds() } }
    ]
  };
};

/** The filter that limits a list of roles to those the actor may see — R5. */
export const roleVisibilityFilter = actor => {
  const { all, businesses } = reachOf(actor, 'roles');
  if (all) return {};
  return {
    $or: [{ business: { $in: objectIds(businesses) } }, { business: null, delegable: true }]
  };
};

const forbid = message => new ErrorResponse(message, 403);

const label = resource => RESOURCES[resource]?.label ?? resource;

/** Does this role (or these personal overrides) let someone manage users or roles? — R6 */
const holdsKeys = (role, overrides) =>
  (role?.permissions ?? []).some(p => NEVER_DELEGATED.has(p.resource) && p.actions?.length) ||
  (overrides ?? []).some(o => o.effect === 'grant' && NEVER_DELEGATED.has(o.resource));

/**
 * Whether the actor may change this person at all (visibility is checked separately, as a 404): not themselves,
 * not an Admin, and not someone who can manage other people — those are an Admin's to change. R6
 */
export const assertCanManageUser = async (actor, target) => {
  if (isAdmin(actor)) return;
  if (String(target._id) === String(actor._id)) {
    throw forbid('You cannot change your own access');
  }
  const role = target.role?.permissions ? target.role : await Role.findById(target.role);
  if (role?.fullAccess) throw forbid('Not authorized to change an Admin');
  if (holdsKeys(role, target.permissionOverrides)) {
    throw forbid('Only an Admin can change someone who can manage people or roles');
  }
};

/**
 * R3 + R4 for a set of permission rows (a role's grid): nothing the actor does not hold, nothing wider than they
 * hold, and never the keys. An empty row grants nothing, so it is allowed.
 */
export const assertWithinCeiling = (actor, permissions) => {
  if (isAdmin(actor)) return;
  const mine = resolvePermissions(actor);
  for (const p of permissions ?? []) {
    if (!p.actions?.length) continue;
    if (NEVER_DELEGATED.has(p.resource)) {
      throw forbid(`Only an Admin can give access to ${label(p.resource)}`);
    }
    const have = mine.get(p.resource);
    if (!have)
      throw forbid(`You cannot give access to ${label(p.resource)}, because you do not have it`);
    const missing = p.actions.filter(a => !have.actions.has(a));
    if (missing.length) {
      throw forbid(
        `You cannot give "${missing.join(', ')}" on ${label(p.resource)}, because you do not have it`
      );
    }
    if (p.scope === 'all' && RESOURCES[p.resource]?.scopable && have.scope !== 'all') {
      throw forbid(`You cannot give wider access to ${label(p.resource)} than you have`);
    }
  }
};

/**
 * May the actor give this role to someone? A role they cannot see is answered as if it did not exist (400), so it
 * does not confirm another business's roles. R3, R4, R5.
 */
export const assertCanGiveRole = (actor, role, overrides) => {
  if (isAdmin(actor)) return;
  if (role.fullAccess) throw forbid('Not authorized to assign the Admin role');

  const { all, businesses } = reachOf(actor, 'users');
  if (!all) {
    const madeHere = role.business && businesses.includes(String(role.business));
    if (!madeHere && !(role.business == null && role.delegable)) {
      throw new ErrorResponse('Please assign a valid role', 400);
    }
  }
  if (overrides?.length) throw forbid('Only an Admin can set personal permissions');
  assertWithinCeiling(actor, role.permissions);
};

/** R1: the businesses a person is assigned must all be the actor's own (and there must be at least one). */
export const assertBusinessesAllowed = (actor, businesses) => {
  if (isAdmin(actor)) return;
  const { all, businesses: mine } = reachOf(actor, 'users');
  if (all) return;
  const wanted = idsOf(businesses);
  if (wanted.length === 0) throw forbid('Choose at least one of your businesses');
  if (wanted.some(b => !mine.includes(b))) throw forbid('You can only assign your own businesses');
};

/**
 * May the actor create or change this role? `role.business` is the business it is made for. An owner works only
 * on roles of their own businesses and must name one when creating; an Admin-granted global manager works on any
 * non-system role; the ceiling (assertWithinCeiling) applies to the grid in every case. R5
 */
export const assertCanWriteRole = (actor, role) => {
  if (isAdmin(actor)) return;
  if (role.isSystem || role.fullAccess) throw forbid('System roles cannot be modified');
  const { all, businesses } = reachOf(actor, 'roles');
  if (all) return;
  if (!role.business || !businesses.includes(String(role.business))) {
    throw forbid('Choose one of your own businesses for this role');
  }
};

/**
 * What the role grid may offer this actor: nothing for an Admin (null = everything), otherwise only the
 * resources and actions they hold, without the ones that are never delegated.
 */
export const grantableFor = actor => {
  if (isAdmin(actor)) return null;
  const out = {};
  for (const [resource, entry] of resolvePermissions(actor)) {
    if (NEVER_DELEGATED.has(resource)) continue;
    out[resource] = { actions: [...entry.actions], scope: entry.scope };
  }
  return out;
};
