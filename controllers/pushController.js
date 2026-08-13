import asyncHandler from '../middlewares/asyncHandler.js';
import ErrorResponse from '../utils/errorResponse.js';
import User from '../models/User.js';

/**
 * @desc      Register this device for push notifications
 * @route     POST /api/v1/push/subscribe
 * @access    Private
 *
 * Not a permissioned resource — every logged-in user manages their own
 * devices, so `protect` alone is the correct gate.
 */
export const subscribeToPush = asyncHandler(async (req, res, next) => {
  const { subscription } = req.body;

  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return next(new ErrorResponse('Invalid subscription object', 400));
  }

  // $addToSet on the endpoint would not deduplicate (keys differ), so match
  // explicitly and only push when this endpoint is genuinely new.
  const result = await User.updateOne(
    { _id: req.user.id, 'pushSubscriptions.endpoint': { $ne: subscription.endpoint } },
    {
      $push: {
        pushSubscriptions: {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth }
        }
      }
    }
  );

  res.status(201).json({
    success: true,
    message: result.modifiedCount ? 'Push subscription saved' : 'Device already subscribed'
  });
});

/**
 * @desc      Remove this device from push notifications
 * @route     POST /api/v1/push/unsubscribe
 * @access    Private
 */
export const unsubscribeFromPush = asyncHandler(async (req, res, next) => {
  const { endpoint } = req.body;

  if (!endpoint) {
    return next(new ErrorResponse('Endpoint is required', 400));
  }

  await User.updateOne({ _id: req.user.id }, { $pull: { pushSubscriptions: { endpoint } } });

  res.status(200).json({ success: true, message: 'Push subscription removed' });
});
