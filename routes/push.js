import express from 'express';
import { subscribeToPush, unsubscribeFromPush } from '../controllers/pushController.js';
import { protect } from '../middlewares/auth.js';

const router = express.Router();

// Require users to be logged in to subscribe their device
router.post('/subscribe', protect, subscribeToPush);
router.post('/unsubscribe', protect, unsubscribeFromPush);

export default router;
