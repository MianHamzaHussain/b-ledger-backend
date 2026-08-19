import { z } from 'zod';

import { PARTY_TYPES } from '../utils/constants.js';

const id = z.string().min(1, 'Required');

export const partyCreateSchema = z.object({
  business: id,
  name: z.string().trim().min(1, 'Please add a name'),
  type: z.enum(Object.values(PARTY_TYPES)),
  phone: z.string().trim().optional(),
  note: z.string().trim().optional(),
  isActive: z.boolean().optional()
  // accountId is derived server-side for couriers — never accepted from the body.
});

export const partyUpdateSchema = partyCreateSchema.partial();
