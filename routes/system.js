import express from 'express';
import { protect } from '../middlewares/auth.js';
import ErrorResponse from '../utils/errorResponse.js';
import { resetData } from '../controllers/systemController.js';

const router = express.Router();

router.use(protect);

/**
 * Admin only — not a resource on the permission grid, because it must never be
 * grantable to anyone else. Admin = the full-access role (roles are data).
 */
const requireAdmin = (req, res, next) =>
  req.user.role?.fullAccess ? next() : next(new ErrorResponse('Only an admin can do this', 403));

/**
 * @swagger
 * /system/reset:
 *   post:
 *     summary: Wipe all business data, keeping users and roles (testing only)
 *     description: >
 *       Admin only, and refused unless the server sets ALLOW_DATA_RESET=true.
 *       Deletes every collection except users, roles and refresh tokens, and
 *       clears every user's assigned businesses.
 *     tags: [System]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [confirm]
 *             properties:
 *               confirm: { type: string, enum: [RESET] }
 *     responses:
 *       200: { description: Data wiped; counts per collection }
 *       400: { description: Missing confirmation }
 *       403: { description: Not an admin, or reset disabled on this server }
 */
router.post('/reset', requireAdmin, resetData);

export default router;
