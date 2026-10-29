import express from 'express';
import { protect } from '../middlewares/auth.js';
import { can, restrictBusinessToScope } from '../middlewares/permissions.js';
import { searchCities, refreshCities } from '../controllers/cityController.js';

const router = express.Router();

router.use(protect);

/**
 * @swagger
 * /cities:
 *   get:
 *     summary: Cities for the search box, marked with what each connected courier serves
 *     tags: [Cities]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: business, schema: { type: string }, description: "Adds each connected courier's own list and tick" }
 *       - { in: query, name: search, schema: { type: string } }
 *       - { in: query, name: page,  schema: { type: integer } }
 *       - { in: query, name: limit, schema: { type: integer, default: 5 } }
 *     responses:
 *       200: { description: "`{ name, served: { postex: true|false } }` — five at a time" }
 */
// Any signed-in user: a list of cities is not a secret (which couriers serve them is, and is only added for your own business).
router.get('/', searchCities);

/**
 * @swagger
 * /cities/refresh:
 *   post:
 *     summary: Ask the couriers for their city lists again (a city may have just reopened)
 *     tags: [Cities]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [business]
 *             properties:
 *               business: { type: string }
 *     responses:
 *       200: { description: "{ refreshed: n }" }
 */
router.post('/refresh', can('orders', 'create'), restrictBusinessToScope(), refreshCities);

export default router;
