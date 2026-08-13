import express from 'express';
import { protect } from '../middlewares/auth.js';
import { can } from '../middlewares/permissions.js';
import {
  getNotifications,
  getUnreadCount,
  markRead,
  markAllRead
} from '../controllers/notificationController.js';

const router = express.Router();

router.use(protect);

/**
 * @swagger
 * tags:
 *   - name: Notifications
 *     description: In-app alerts for the businesses you're assigned to
 */

/**
 * @swagger
 * /notifications:
 *   get:
 *     summary: Recent notifications for your businesses (newest first, max 30)
 *     tags: [Notifications]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: List, each with per-user isRead
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data:
 *                 - { _id: "66c...01", type: new-order, title: "New order #0013", body: "Kamran · Rs 2000", link: /orders, isRead: false, createdAt: "2026-08-06T10:05:00.000Z" }
 *                 - { _id: "66c...02", type: low-stock, title: "Low stock: Lawn Suit", body: "Default — 2 left", link: /products, isRead: true, createdAt: "2026-08-06T10:04:00.000Z" }
 */
router.get('/', can('notifications', 'read'), getNotifications);

/**
 * @swagger
 * /notifications/unread-count:
 *   get:
 *     summary: Unread count (bell badge)
 *     tags: [Notifications]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Number unread for this user
 *         content:
 *           application/json:
 *             example: { success: true, data: { count: 3 } }
 */
router.get('/unread-count', can('notifications', 'read'), getUnreadCount);

/**
 * @swagger
 * /notifications/read-all:
 *   put:
 *     summary: Mark all read
 *     tags: [Notifications]
 *     security: [{ bearerAuth: [] }]
 *     responses: { 200: { description: Done } }
 */
router.put('/read-all', can('notifications', 'update'), markAllRead);

/**
 * @swagger
 * /notifications/{id}/read:
 *   put:
 *     summary: Mark one read
 *     tags: [Notifications]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses: { 200: { description: Done }, 404: { description: Not found } }
 */
router.put('/:id/read', can('notifications', 'update'), markRead);

export default router;
