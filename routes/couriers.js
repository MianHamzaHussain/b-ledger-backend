import express from 'express';
import { protect } from '../middlewares/auth.js';
import { can, restrictBusinessToScope } from '../middlewares/permissions.js';
import { validate } from '../middlewares/validate.js';
import { courierCreateSchema } from '../schemas/couriers.js';
import { addCourier, getProviders, listCouriers } from '../controllers/courierController.js';

const router = express.Router();
router.use(protect);

/**
 * @swagger
 * /couriers/providers:
 *   get:
 *     summary: The courier services the app can connect, and the values each one needs
 *     tags: [Couriers]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "[{ id, label, fields: [{ name, label, secret? }], note }]" }
 */
router.get('/providers', can('couriers', 'read'), getProviders);

/**
 * @swagger
 * /couriers:
 *   get:
 *     summary: A business's couriers — connection, balance, parcels out and wallet (never the key)
 *     tags: [Couriers]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: business, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: The couriers }
 *   post:
 *     summary: Add a courier in one step — Khata party, key, test, pickup address, automatic steps and wallet
 *     tags: [Couriers]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: "The courier, the pickup addresses, and whether one still has to be chosen" }
 *       502: { description: The courier refused the key — nothing was saved }
 */
router
  .route('/')
  .get(can('couriers', 'read'), listCouriers)
  .post(
    can('couriers', 'create'),
    restrictBusinessToScope(),
    validate(courierCreateSchema),
    addCourier
  );

export default router;
