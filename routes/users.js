import express from 'express';
import { protect } from '../middlewares/auth.js';
import { can } from '../middlewares/permissions.js';
import advancedResults from '../middlewares/advancedResults.js';
import User from '../models/User.js';
import {
  getUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
  reinviteUser
} from '../controllers/userController.js';

const router = express.Router();

router.use(protect);

/**
 * @swagger
 * /users/{id}/reinvite:
 *   post:
 *     summary: Resend a user's invitation with a fresh 24h link
 *     tags: [Users]
 *     description: Only valid for accounts that have never signed in.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Invitation resent; `emailSent` reports delivery }
 *       400: { description: User has already activated their account }
 *       404: { description: User not found }
 */
// Literal sub-path before the parameterised /:id routes.
router.post('/:id/reinvite', can('users', 'create'), reinviteUser);

/**
 * @swagger
 * /users:
 *   get:
 *     summary: Get all users
 *     tags: [Users]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: search, schema: { type: string } }
 *       - { in: query, name: status, schema: { type: string, enum: [active, inactive] } }
 *       - { in: query, name: page,   schema: { type: integer } }
 *       - { in: query, name: limit,  schema: { type: integer } }
 *     responses:
 *       200:
 *         description: List of users
 *       403:
 *         description: Missing users:read permission
 *   post:
 *     summary: Create a user and email them an invitation
 *     tags: [Users]
 *     description: >
 *       No password is accepted or generated for the caller to pass on. The
 *       user receives a single-use link and sets their own password.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, email, phone, role]
 *             properties:
 *               name:  { type: string, example: "Ali Raza" }
 *               email: { type: string, format: email, example: "ali@b-ledger.pk" }
 *               phone: { type: string, example: "+923001234567" }
 *               role:  { type: string, description: "Role ObjectId" }
 *               assignedBusinesses:
 *                 type: array
 *                 items: { type: string }
 *                 description: Business ObjectIds this user works on
 *               permissionOverrides:
 *                 type: array
 *                 description: Per-user grant/deny deltas on top of the role
 *                 items:
 *                   type: object
 *                   properties:
 *                     resource: { type: string, example: businesses }
 *                     actions:  { type: array, items: { type: string }, example: [read] }
 *                     effect:   { type: string, enum: [grant, deny] }
 *                     scope:    { type: string, enum: [all, own] }
 *     responses:
 *       201:
 *         description: User created; `emailSent` reports invite delivery
 *       400:
 *         description: Validation error or invalid role
 *       403:
 *         description: Missing users:create permission, or assigning Admin without being one
 */
router
  .route('/')
  .get(can('users', 'read'), advancedResults(User, 'role', ['name', 'email', 'phone']), getUsers)
  .post(can('users', 'create'), createUser);

/**
 * @swagger
 * /users/{id}:
 *   get:
 *     summary: Get single user
 *     tags: [Users]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: User }
 *       404: { description: User not found }
 *   put:
 *     summary: Update a user
 *     tags: [Users]
 *     description: Passwords cannot be set here; users change their own via /auth/updatepassword.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: User updated }
 *       403: { description: Not authorized to assign the Admin role }
 *   delete:
 *     summary: Delete a user
 *     tags: [Users]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: User deleted }
 *       400: { description: Cannot delete your own account }
 */
router
  .route('/:id')
  .get(can('users', 'read'), getUser)
  .put(can('users', 'update'), updateUser)
  .delete(can('users', 'delete'), deleteUser);

export default router;
