import { z } from 'zod';
import { courierConnectionSchema } from './parties.js';

const id = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

/**
 * "Add courier": the courier's name, and — unless it is one tracked by hand — its service and the values that
 * service signs in with. Every other setting is chosen by the server (booking, automatic delivered / returned,
 * following typed-in numbers), so the form stays one short screen.
 */
export const courierCreateSchema = z
  .object({
    business: id,
    name: z.string().trim().min(1, 'Please add a name').max(100),
    phone: z.string().trim().max(30).optional(),
    note: z.string().trim().max(200).optional(),
    ...courierConnectionSchema.pick({
      provider: true,
      token: true,
      credentials: true,
      accountNumber: true,
      serviceCode: true
    }).shape
  })
  .superRefine((v, ctx) => {
    if (!v.provider) return;
    const isTcs = v.provider === 'tcs';
    if (isTcs ? !v.credentials || !v.accountNumber : !v.token) {
      ctx.addIssue({
        code: 'custom',
        path: [isTcs ? 'credentials' : 'token'],
        message: isTcs ? 'Enter all the TCS details' : 'Paste the PostEx key'
      });
    }
  });
