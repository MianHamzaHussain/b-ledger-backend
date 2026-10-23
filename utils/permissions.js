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
 *  description — one plain sentence on what this area is, for the person making a role
 *  can       — per action, a plain phrase for what ticking it lets someone do. An
 *              action with no phrase does nothing here, and the UI greys it out.
 *              test/permissionDescriptions.test.js fails if a route needs an action
 *              that has no phrase, so a new route can not go undescribed.
 *  scopable  — whether `own` is meaningful; if false, scope is forced to 'all'
 *  ownFilter — (user) => Mongo filter fragment applied when scope === 'own'.
 *              This is what makes "a dispatcher sees only their businesses'
 *              orders" a one-line declaration instead of per-controller logic.
 */
export const RESOURCES = {
  users: {
    label: 'Users',
    description:
      'The people who can sign in to B Ledger. Be careful: someone who can change users can give people more access.',
    can: {
      read: 'see who has an account and what role they have',
      create: 'add and invite new people',
      update: "change a person's role, businesses and access, or switch them off",
      delete: 'remove a person'
    },
    scopable: false
  },
  roles: {
    label: 'Roles',
    description:
      'Sets of access, like the one you are making now. Be careful: whoever can change roles can give anyone, even themselves, more access.',
    can: {
      read: 'see the roles',
      create: 'make new roles',
      update: 'change what a role is allowed to do',
      delete: 'remove a role'
    },
    scopable: false
  },
  businesses: {
    label: 'Businesses',
    description: 'Your shops and brands.',
    can: {
      read: 'see the businesses',
      create: 'add a business',
      update: "change a business's details and courier taxes",
      delete: 'remove a business'
    },
    scopable: true,
    ownFilter: user => ({ _id: { $in: user.assignedBusinesses || [] } })
  },
  categories: {
    label: 'Categories',
    description: 'The kinds of product you sell, and their sizes (for example Clothing).',
    can: {
      read: 'see the categories',
      create: 'add a category',
      update: 'change a category and its sizes',
      delete: 'remove a category'
    },
    // Categories are shared reference data, not owned by a business — there
    // is no meaningful "own" subset, so scope is always 'all'.
    scopable: false
  },
  products: {
    label: 'Products',
    description: 'Your products: their sizes, selling prices and how many are in stock.',
    can: {
      read: 'see products and stock',
      create: 'add new products',
      update: 'change products, sizes and prices',
      delete: 'remove products'
    },
    // Owned by a business — a dispatcher sees only their businesses' stock.
    scopable: true,
    ownFilter: user => ({ business: { $in: user.assignedBusinesses || [] } })
  },
  orders: {
    label: 'Orders',
    description: 'Customer orders, from taking the order to delivery.',
    can: {
      read: 'see orders and their status',
      create: 'take new orders',
      update:
        'change orders, send them with a courier, mark them delivered or returned, and record advances and refunds'
    },
    scopable: true,
    ownFilter: user => ({ business: { $in: user.assignedBusinesses || [] } })
  },
  customers: {
    label: 'Customers',
    description: 'The people who buy from you: names, phone numbers and cities.',
    can: {
      read: 'see customers',
      update: "correct a customer's name or city"
    },
    scopable: true,
    ownFilter: user => ({ business: { $in: user.assignedBusinesses || [] } })
  },

  // ── Accounting module ───────────────────────────────────────────────────
  parties: {
    label: 'Khata (parties)',
    description:
      'Khata: the suppliers, tailors, couriers, shops and staff you owe money to, or who owe you.',
    can: {
      read: 'see their accounts and balances',
      create: 'add someone to Khata',
      update: "change someone's details",
      delete: 'remove someone from Khata'
    },
    scopable: true,
    ownFilter: user => ({ business: { $in: user.assignedBusinesses || [] } })
  },
  accounts: {
    label: 'Chart of Accounts',
    description:
      'Your cash, bank and wallet accounts, and the full list of accounts the books use.',
    can: {
      read: 'see the accounts',
      create: 'add a bank or wallet account',
      update: 'rename or switch off a money account'
    },
    scopable: true,
    ownFilter: user => ({ business: { $in: user.assignedBusinesses || [] } })
  },
  production: {
    // Production batches — building an article's cost from its inputs.
    label: 'Production & Costing',
    description:
      "Making your own stock in batches, and what each batch cost. Also needs 'See costs & profit'.",
    can: {
      read: 'see batches and their costs',
      create: 'start a new batch',
      update: 'change a batch and close it into stock',
      delete: 'remove a batch that is not closed yet'
    },
    scopable: true,
    ownFilter: user => ({ business: { $in: user.assignedBusinesses || [] } })
  },
  materials: {
    // Raw materials bought in bulk and used by production batches. Quantities
    // are everyday stock-keeping; their prices are costs (hidden without `costs`).
    label: 'Raw materials',
    description: 'Raw materials such as cloth, thread and lace kept in the store.',
    can: {
      read: 'see materials and how much is left',
      create: 'add materials and record what was bought',
      update: 'record waste or a stock count, and undo a purchase',
      delete: 'remove a material'
    },
    scopable: true,
    ownFilter: user => ({ business: { $in: user.assignedBusinesses || [] } })
  },
  consignments: {
    // Sale-or-return: goods out with a reseller until kept/paid or returned.
    label: 'Sale or Return',
    description: 'Goods given to shops on sale or return.',
    can: {
      read: 'see what is out with each shop',
      create: 'give goods to a shop',
      update: 'record goods returned, goods kept and payments',
      delete: 'cancel a handover nothing has happened to'
    },
    scopable: true,
    ownFilter: user => ({ business: { $in: user.assignedBusinesses || [] } })
  },
  goodsReceipts: {
    // Finished goods delivered by a supplier: stock in, what is owed, and any sent back.
    label: 'Goods received',
    description: 'Ready-made goods that a supplier delivers to you.',
    can: {
      read: 'see deliveries from suppliers',
      create: 'record a new delivery',
      update: 'change a delivery’s note, send goods back to the supplier, or undo a delivery'
    },
    scopable: true,
    ownFilter: user => ({ business: { $in: user.assignedBusinesses || [] } })
  },
  partners: {
    // Owners/partners — equity stakes, capital contributions, drawings, profit share.
    label: 'Partners & Capital',
    description: 'The owners, their share of the profit, and money they put in or take out.',
    can: {
      read: 'see the partners and their money',
      create: 'add a partner',
      update: 'record money put in or taken out, and share the profit',
      delete: 'remove a partner'
    },
    scopable: true,
    ownFilter: user => ({ business: { $in: user.assignedBusinesses || [] } })
  },
  journal: {
    // Recording money movements (capital, expenses, payments, salary) and
    // reading the ledger. create = post an entry, read = view the books.
    label: 'Money (bookkeeping)',
    description: 'Everyday money records: expenses, payments, salaries and the cash book.',
    can: {
      read: 'see the cash book, expenses and money records',
      create: 'record expenses, payments, salaries and money moved between accounts',
      update: 'undo a money record, and lock the books up to a date',
      delete: 'unlock the books'
    },
    scopable: true,
    ownFilter: user => ({ business: { $in: user.assignedBusinesses || [] } })
  },
  accounting: {
    // Accountant-only tools, kept off everyday screens: a raw debit/credit
    // General entry, depreciation and the year-end close. read = see the
    // accountant area (trial balance, journal); create = post those entries.
    label: 'Accountant tools',
    description:
      'Advanced bookkeeping for an accountant: debit and credit entries, depreciation and the year-end close. Give this only to someone who knows accounting.',
    can: {
      read: 'see the accountant screens, such as the trial balance',
      create: 'post debit and credit entries, depreciation and the year-end close'
    },
    scopable: true,
    ownFilter: user => ({ business: { $in: user.assignedBusinesses || [] } })
  },
  reports: {
    label: 'Reports',
    description: 'Profit and loss, balance sheet and courier reports.',
    can: {
      read: 'see the reports'
    },
    scopable: true,
    ownFilter: user => ({ business: { $in: user.assignedBusinesses || [] } })
  },
  costs: {
    // "See costs & profit": what an article cost to make, per-line margins and
    // product profitability. A trade secret — owners and partners only. Without
    // it the server strips every cost field from responses (hideCosts) and the
    // production screens, which are all costs, are closed.
    label: 'See costs & profit',
    description:
      'Whether the person may see what things cost you and how much profit you make. Without this, costs and profit are hidden everywhere.',
    can: {
      read: 'see costs, margins and profit'
    },
    scopable: false
  },
  notifications: {
    // In-app alerts for the businesses a user is assigned to.
    label: 'Notifications',
    description: 'Alerts inside the app, such as new orders and low stock.',
    can: {
      read: 'see their notifications',
      update: 'mark them as read'
    },
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
    description: RESOURCES[key].description,
    can: RESOURCES[key].can,
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

/**
 * Whether a user may take an action on a resource — the same rule as `can()`
 * (admin passes; deny overrides win), for code that needs a yes/no rather than
 * a route guard.
 */
export const userCan = (user, resource, action) =>
  Boolean(user?.role?.fullAccess) ||
  Boolean(
    resolvePermissions(user || {})
      .get(resource)
      ?.actions.has(action)
  );
