import express from 'express';
import { protect } from '../middlewares/auth.js';
import { can, loadScoped } from '../middlewares/permissions.js';
import advancedResults from '../middlewares/advancedResults.js';
import Role from '../models/Role.js';
import {
  getRegistry,
  getRoles,
  getRole,
  createRole,
  updateRole,
  deleteRole
} from '../controllers/roleController.js';

const router = express.Router();

router.use(protect);

/**
 * @swagger
 * /roles/registry:
 *   get:
 *     summary: Get the permission registry
 *     tags: [Roles]
 *     description: >
 *       Returns every permissionable resource, the available actions and
 *       scopes. The admin UI renders its checkbox grid from this, so resource
 *       names are never hardcoded in the frontend.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Permission registry
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data:
 *                 actions: [read, create, update, delete]
 *                 scopes: [all, own]
 *                 resources:
 *                   - { key: users,      label: Users,      scopable: false }
 *                   - { key: roles,      label: Roles,      scopable: false }
 *                   - { key: businesses, label: Businesses, scopable: true }
 */
// Literal path must be declared before /:id or Express matches it as an id.
router.get('/registry', can('roles', 'read'), getRegistry);

/**
 * @swagger
 * /roles:
 *   get:
 *     summary: Get all roles
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: query, name: search, schema: { type: string } }
 *       - { in: query, name: page,   schema: { type: integer } }
 *       - { in: query, name: limit,  schema: { type: integer } }
 *     responses:
 *       200:
 *         description: List of roles
 *   post:
 *     summary: Create a role
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Role'
 *           example:
 *             name: Dispatcher
 *             description: Handles order dispatch for assigned businesses
 *             permissions:
 *               - { resource: businesses, actions: [read], scope: own }
 *     responses:
 *       201:
 *         description: Role created
 *       400:
 *         description: Validation error (unknown resource or action)
 */
router
  .route('/')
  .get(can('roles', 'read'), advancedResults(Role, null, ['name', 'description']), getRoles)
  .post(can('roles', 'create'), createRole);

/**
 * @swagger
 * /roles/{id}:
 *   get:
 *     summary: Get single role
 *     tags: [Roles]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Role }
 *       404: { description: Role not found }
 *   put:
 *     summary: Update a role
 *     tags: [Roles]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Role updated }
 *       403: { description: System roles cannot be modified }
 *   delete:
 *     summary: Delete a role
 *     tags: [Roles]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Role deleted }
 *       400: { description: Role still assigned to users }
 *       403: { description: System roles cannot be deleted }
 */
router
  .route('/:id')
  .get(can('roles', 'read'), loadScoped(Role), getRole)
  .put(can('roles', 'update'), loadScoped(Role), updateRole)
  .delete(can('roles', 'delete'), loadScoped(Role), deleteRole);

export default router;
