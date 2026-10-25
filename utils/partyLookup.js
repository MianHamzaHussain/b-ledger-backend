import { resolvePermissions } from './permissions.js';
import { PARTY_TYPES } from './constants.js';

/**
 * Picking a person for a task is not the same as seeing the Khata. Someone who dispatches parcels
 * must choose a courier, but the party list also carries every party's balance and the statements
 * behind it — so giving a dispatcher Khata access to find a courier showed them the whole business.
 *
 * `GET /parties/lookup` answers only "who can I pick?" (name, phone, account id — never a balance).
 * Who may ask is the permission for the TASK that needs the person, per type; a person with Khata
 * access (`parties:read`) may always ask.
 */
export const LOOKUP_TASKS = {
  [PARTY_TYPES.COURIER]: [['orders', 'update']],
  [PARTY_TYPES.CUSTOMER]: [
    ['orders', 'create'],
    ['orders', 'update']
  ],
  [PARTY_TYPES.SUPPLIER]: [
    ['goodsReceipts', 'create'],
    ['materials', 'create'],
    ['production', 'create'],
    ['production', 'update'],
    ['journal', 'create']
  ],
  [PARTY_TYPES.RESELLER]: [
    ['consignments', 'create'],
    ['consignments', 'update'],
    ['journal', 'create']
  ],
  [PARTY_TYPES.EMPLOYEE]: [
    ['production', 'create'],
    ['production', 'update'],
    ['journal', 'create']
  ],
  [PARTY_TYPES.LENDER]: [['journal', 'create']]
};

/**
 * 'all' / 'own' when this user may pick a party of this type, or null when not. The widest scope of
 * any permission that allows it wins, the same way a role plus a grant override does elsewhere.
 */
export const lookupScope = (user, type) =>
  widestScope(user, [['parties', 'read'], ...(LOOKUP_TASKS[type] ?? [])]);

/**
 * 'all' / 'own' when the user holds any of these [resource, action] permissions, else null. The
 * widest scope wins, the same way a role plus a grant override does elsewhere.
 */
export const widestScope = (user, needs) => {
  if (user?.role?.fullAccess) return 'all';
  const granted = resolvePermissions(user || {});
  let scope = null;
  for (const [resource, action] of needs) {
    const entry = granted.get(resource);
    if (!entry?.actions.has(action)) continue;
    if (entry.scope === 'all') return 'all';
    scope = 'own';
  }
  return scope;
};
