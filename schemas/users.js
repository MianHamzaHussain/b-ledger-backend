import { z } from 'zod';

import { RESOURCE_KEYS, ACTIONS, SCOPES } from '../utils/permissions.js';

const id = z.string().min(1, 'Required');

// A per-user grant/deny on top of the role's grid (User.permissionOverrides).
const override = z.object({
  resource: z.enum(RESOURCE_KEYS),
  actions: z.array(z.enum(ACTIONS)).optional(),
  effect: z.enum(['grant', 'deny']),
  scope: z.enum(SCOPES).optional()
});

// Password is server-generated on invite (never accepted from the body), so it
// is not in the schema — the controller sets a random one and forces a reset.
export const userCreateSchema = z.object({
  name: z.string().trim().min(1, 'Please add a name'),
  email: z.string().trim().min(1, 'Please add an email'),
  phone: z.string().trim().min(1, 'Please add a phone number'),
  role: id,
  assignedBusinesses: z.array(id).optional(),
  permissionOverrides: z.array(override).optional(),
  status: z.enum(['active', 'inactive']).optional()
});

export const userUpdateSchema = userCreateSchema.partial();
