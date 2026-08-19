import express from 'express';
import { subscribeToPush, unsubscribeFromPush } from '../controllers/pushController.js';
import { protect } from '../middlewares/auth.js';
import { validate } from '../middlewares/validate.js';
import { pushSubscribeSchema, pushUnsubscribeSchema } from '../schemas/push.js';

const router = express.Router();

// Require users to be logged in to subscribe their device
router.post('/subscribe', protect, validate(pushSubscribeSchema), subscribeToPush);
router.post('/unsubscribe', protect, validate(pushUnsubscribeSchema), unsubscribeFromPush);

export default router;
