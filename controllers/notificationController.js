import asyncHandler from '../middlewares/asyncHandler.js';
import ErrorResponse from '../utils/errorResponse.js';
import Notification from '../models/Notification.js';

/**
 * Notifications are business-scoped: `can('notifications', …)` sets
 * `req.accessFilter` to the businesses the user may see (`{}` for admins), and
 * these handlers apply it — the same pattern as every other scoped resource.
 * Read state is per-user via `readBy`.
 */

/**
 * @desc   Notifications for the user's businesses, newest first. Paginated so
 *         the bell can ask for the recent few and the "view all" page can scroll
 *         through the lot. `isRead` is resolved per-user from `readBy`.
 * @route  GET /api/v1/notifications?page=&limit=  (notifications:read — scoped)
 */
export const getNotifications = asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 30));
  const filter = req.accessFilter || {};

  const total = await Notification.countDocuments(filter);
  const notes = await Notification.find(filter)
    .sort('-createdAt')
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();
  const uid = String(req.user.id);

  const data = notes.map(({ readBy, ...n }) => ({
    ...n,
    isRead: (readBy || []).map(String).includes(uid)
  }));

  res.status(200).json({
    success: true,
    count: data.length,
    total,
    pagination: page * limit < total ? { next: { page: page + 1, limit } } : {},
    data
  });
});

/**
 * @desc   How many are unread — powers the bell badge
 * @route  GET /api/v1/notifications/unread-count  (notifications:read — scoped)
 */
export const getUnreadCount = asyncHandler(async (req, res) => {
  const count = await Notification.countDocuments({
    $and: [req.accessFilter || {}, { readBy: { $ne: req.user.id } }]
  });
  res.status(200).json({ success: true, data: { count } });
});

/**
 * @desc   Mark one read
 * @route  PUT /api/v1/notifications/:id/read  (notifications:update — scoped)
 */
export const markRead = asyncHandler(async (req, res, next) => {
  const note = await Notification.findOne({
    $and: [req.accessFilter || {}, { _id: req.params.id }]
  });
  if (!note) return next(new ErrorResponse('Notification not found', 404));

  await Notification.updateOne({ _id: note._id }, { $addToSet: { readBy: req.user.id } });
  res.status(200).json({ success: true, data: {} });
});

/**
 * @desc   Mark all read
 * @route  PUT /api/v1/notifications/read-all  (notifications:update — scoped)
 */
export const markAllRead = asyncHandler(async (req, res) => {
  await Notification.updateMany(
    { $and: [req.accessFilter || {}, { readBy: { $ne: req.user.id } }] },
    { $addToSet: { readBy: req.user.id } }
  );
  res.status(200).json({ success: true, data: {} });
});
