/**
 * Permission registry — the single server-side source of truth.
 *
 * The admin UI renders its checkbox grid by GET /api/v1/roles/registry.
 * The frontend never invents resource names; it can only echo back what is
 * declared here. A typo therefore fails loudly at validation instead of
 * silently creating a permission that matches nothing.
 *
 * APPEND-ONLY: add a line here in the same commit that adds the model and
 * routes for a new resource. Never register a resource that has no endpoints —
 * it produces checkboxes that grant nothing.
 */

/** Every action a permission can carry. */
export const ACTIONS = ['read', 'create', 'update', 'delete'];

/**
 * Row visibility for `read`.
 *  all — every row of the resource
 *  own — only rows tied to the businesses the user is assigned to
 */
export const SCOPES = ['all', 'own'];

/**
 * Resource declarations.
 *
 *  label     — human label for the admin checkbox UI
 *  scopable  — whether `own` is meaningful; if false, scope is forced to 'all'
 *  ownFilter — (user) => Mongo filter fragment applied when scope === 'own'.
 *              This is what makes "a dispatcher sees only their businesses'
 *              orders" a one-line declaration instead of per-controller logic.
 */
export const RESOURCES = {
  users: {
    label: 'Users',
    scopable: false
  },
  roles: {
    label: 'Roles',
    scopable: false
  },
  businesses: {
    label: 'Businesses',
    scopable: true,
    ownFilter: user => ({ _id: { $in: user.assignedBusinesses || [] } })
  },
  categories: {
    label: 'Categories',
    // Categories are shared reference data, not owned by a business — there
    // is no meaningful "own" subset, so scope is always 'all'.
    scopable: false
  },
  products: {
    label: 'Products',
    // Owned by a business — a dispatcher sees only their businesses' stock.
    scopable: true,
    ownFilter: user => ({ business: { $in: user.assignedBusinesses || [] } })
  },
  orders: {
    label: 'Orders',
    scopable: true,
    ownFilter: user => ({ business: { $in: user.assignedBusinesses || [] } })
  },
  customers: {
    label: 'Customers',
    scopable: true,
    ownFilter: user => ({ business: { $in: user.assignedBusinesses || [] } })
  },

  // ── Accounting module ───────────────────────────────────────────────────
  parties: {
    label: 'Parties',
    scopable: true,
    ownFilter: user => ({ business: { $in: user.assignedBusinesses || [] } })
  },
  accounts: {
    label: 'Chart of Accounts',
    scopable: true,
    ownFilter: user => ({ business: { $in: user.assignedBusinesses || [] } })
  },
  production: {
    // Production batches — building an article's cost from its inputs.
    label: 'Production & Costing',
    scopable: true,
    ownFilter: user => ({ business: { $in: user.assignedBusinesses || [] } })
  },
  consignments: {
    // Sale-or-return: goods out with a reseller until kept/paid or returned.
    label: 'Sale or Return',
    scopable: true,
    ownFilter: user => ({ business: { $in: user.assignedBusinesses || [] } })
  },
  partners: {
    // Owners/partners — equity stakes, capital contributions, drawings, profit share.
    label: 'Partners & Capital',
    scopable: true,
    ownFilter: user => ({ business: { $in: user.assignedBusinesses || [] } })
  },
  journal: {
    // Recording money movements (capital, expenses, payments, salary) and
    // reading the ledger. create = post an entry, read = view the books.
    label: 'Bookkeeping',
    scopable: true,
    ownFilter: user => ({ business: { $in: user.assignedBusinesses || [] } })
  },
  reports: {
    label: 'Reports',
    scopable: true,
    ownFilter: user => ({ business: { $in: user.assignedBusinesses || [] } })
  },
  notifications: {
    // In-app alerts for the businesses a user is assigned to.
    label: 'Notifications',
    scopable: true,
    ownFilter: user => ({ business: { $in: user.assignedBusinesses || [] } })
  }
};

/** Resource keys as an array — used for schema enums and registry responses. */
export const RESOURCE_KEYS = Object.keys(RESOURCES);

/**
 * Shape handed to the admin UI so it can render the grid without hardcoding
 * anything. Functions are stripped — this crosses the wire.
 */
export const getPermissionRegistry = () => ({
  actions: ACTIONS,
  scopes: SCOPES,
  resources: RESOURCE_KEYS.map(key => ({
    key,
    label: RESOURCES[key].label,
    scopable: Boolean(RESOURCES[key].scopable)
  }))
});

/**
 * Collapse a user's role permissions and personal overrides into one lookup.
 *
 * Resolution order — deny always wins:
 *   1. start from the role's permission list
 *   2. apply `grant` overrides (union of actions; scope widens to 'all')
 *   3. apply `deny`  overrides (subtract actions; empty set removes the entry)
 *
 * Admin is NOT resolved here — `can()` bypasses this function entirely, so an
 * admin can never be locked out by a bad checkbox.
 *
 * @param {object} user - user document with `role` populated
 * @returns {Map<string, { actions: Set<string>, scope: string }>}
 */
export const resolvePermissions = user => {
  const resolved = new Map();

  for (const perm of user.role?.permissions || []) {
    if (!RESOURCES[perm.resource]) continue; // registry removed it — ignore stale rows
    resolved.set(perm.resource, {
      actions: new Set(perm.actions),
      scope: RESOURCES[perm.resource].scopable ? perm.scope || 'own' : 'all'
    });
  }

  for (const ovr of user.permissionOverrides || []) {
    if (!RESOURCES[ovr.resource]) continue;
    const current = resolved.get(ovr.resource) || { actions: new Set(), scope: 'own' };

    if (ovr.effect === 'grant') {
      ovr.actions.forEach(a => current.actions.add(a));
      if (ovr.scope === 'all') current.scope = 'all';
      resolved.set(ovr.resource, current);
    } else {
      ovr.actions.forEach(a => current.actions.delete(a));
      if (current.actions.size === 0) resolved.delete(ovr.resource);
      else resolved.set(ovr.resource, current);
    }
  }

  return resolved;
};
