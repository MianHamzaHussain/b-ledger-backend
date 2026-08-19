import { z } from 'zod';

// The shape the browser's PushManager produces via `subscription.toJSON()`.
export const pushSubscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.string().min(1, 'A push endpoint is required'),
    keys: z.object({
      p256dh: z.string().min(1),
      auth: z.string().min(1)
    })
  })
});

export const pushUnsubscribeSchema = z.object({
  endpoint: z.string().min(1, 'A push endpoint is required')
});
