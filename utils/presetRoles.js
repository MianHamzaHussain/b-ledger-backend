import Role from '../models/Role.js';
import { BUSINESS_OWNER_ROLE_NAME } from './constants.js';
import { RESOURCES } from './permissions.js';

/**
 * The predefined **Business Owner** role: the boss of a business. It carries everything that business runs on —
 * orders, stock, production, people, roles, integrations, money screens — each at the owner's OWN businesses only,
 * so one owner never sees another's. What an owner can then hand to their own people is limited by the rules in
 * `utils/delegation.js` (never more than they hold; never Users, Roles or Accountant tools).
 *
 * It is an explicit allow-list: an area added to the permission registry later is NOT given to every owner by
 * default — `test/presetRoles.test.js` fails until someone decides which list it belongs to.
 *   'all'  = every action that area has;  [..] = only those actions.
 */
export const OWNER_ACCESS = {
  users: 'all',
  roles: 'all',
  // Their own business's details and settings — but a business is created and removed by an Admin.
  businesses: ['read', 'update'],
  // Categories are shared by every business (not scoped to one), so an owner may look but not change them.
  categories: ['read'],
  products: 'all',
  orders: 'all',
  customers: 'all',
  parties: 'all',
  integrations: 'all',
  accounts: 'all',
  production: 'all',
  materials: 'all',
  consignments: 'all',
  goodsReceipts: 'all',
  partners: 'all',
  journal: 'all',
  reports: ['read'],
  costs: ['read'],
  notifications: ['read', 'update']
};

/**
 * Left to an Admin on purpose. "Accountant tools" are the raw debit/credit entry, depreciation and the year-end
 * close — a slip there changes the books for good, so an Admin ticks it for a particular owner if they want it.
 */
export const NOT_FOR_OWNERS = ['accounting'];

/** The permission rows of the Business Owner role, built from the registry so the actions are always real ones. */
export const ownerPermissions = () =>
  Object.entries(OWNER_ACCESS).map(([resource, access]) => ({
    resource,
    actions: access === 'all' ? Object.keys(RESOURCES[resource].can) : access,
    // A shared area (categories, costs) has no per-business scope; everything else is limited to their own.
    scope: RESOURCES[resource].scopable ? 'own' : 'all'
  }));

/**
 * Make sure the Business Owner role exists. Safe to run on every start: a role by that name is never touched, so an
 * Admin who edited it (or made their own with the same name) keeps what they set. Returns whether it was created.
 */
export const ensureBusinessOwnerRole = async () => {
  if (await Role.exists({ name: BUSINESS_OWNER_ROLE_NAME, business: null })) return false;
  try {
    await Role.create({
      name: BUSINESS_OWNER_ROLE_NAME,
      description:
        'The boss of a business: runs everything for their own businesses, and manages their own people, roles and integrations.',
      permissions: ownerPermissions()
    });
    return true;
  } catch (err) {
    // Two servers starting at once: the other one made it first (the unique name index says so).
    if (err?.code === 11000) return false;
    throw err;
  }
};
