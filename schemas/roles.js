import { z } from 'zod';

import { RESOURCE_KEYS, ACTIONS, SCOPES } from '../utils/permissions.js';

// One row of the permission grid. fullAccess/isSystem are seeder-only and are
// deleted by the controller, so they are deliberately absent here.
const permission = z.object({
  resource: z.enum(RESOURCE_KEYS),
  actions: z.array(z.enum(ACTIONS)).optional(),
  scope: z.enum(SCOPES).optional()
});

export const roleCreateSchema = z.object({
  name: z.string().trim().min(1, 'Please add a role name'),
  description: z.string().trim().optional(),
  permissions: z.array(permission).optional(),
  /** The business this role is for (required for an owner; an Admin may leave it out for an everyone-role). */
  business: z.string().min(1).optional(),
  /** Admin only: owners may give this role to their people. Ignored for anyone else. */
  delegable: z.boolean().optional()
});

export const roleUpdateSchema = roleCreateSchema.partial();
