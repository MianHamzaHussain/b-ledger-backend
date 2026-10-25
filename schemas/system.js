import { z } from 'zod';

/** Clear one business's records — the typed name must match the business exactly. */
export const resetSchema = z.object({
  business: z.string().min(1, 'Choose a business'),
  confirmName: z.string().min(1, 'Type the business name to confirm')
});
