import express from 'express';
import { protect } from '../middlewares/auth.js';
import { can, loadScoped, restrictBusinessToScope } from '../middlewares/permissions.js';
import advancedResults from '../middlewares/advancedResults.js';
import Order from '../models/Order.js';
import {
  getOrders,
  getOrder,
  createOrder,
  updateOrder,
  exchangeOrder,
  updateOrderStatus,
  updateOrderPayment,
  updateOrderTracking,
  getPriceHint
} from '../controllers/orderController.js';

const router = express.Router();

router.use(protect);

/**
 * @swagger
 * /orders/price-hint:
 *   get:
 *     summary: Last price a product/variant sold at (form prefill)
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: product,   required: true, schema: { type: string } }
 *       - { in: query, name: variantId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: "{ lastPrice: number | null }" }
 */
// Literal path before /:id so it is not swallowed as an id.
router.get('/price-hint', can('orders', 'read'), getPriceHint);

/**
 * @swagger
 * /orders:
 *   get:
 *     summary: Get all orders
 *     tags: [Orders]
 *     description: Scoped by business. Search matches order number, customer name or phone.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: business,      schema: { type: string } }
 *       - { in: query, name: status,        schema: { type: string, enum: [pending, confirmed, dispatched, delivered, cancelled, returned] } }
 *       - { in: query, name: paymentStatus, schema: { type: string, enum: [unpaid, paid] } }
 *       - { in: query, name: search,        schema: { type: string } }
 *       - { in: query, name: page,          schema: { type: integer } }
 *       - { in: query, name: limit,         schema: { type: integer } }
 *     responses:
 *       200: { description: List of orders }
 *   post:
 *     summary: Create an order
 *     tags: [Orders]
 *     description: >
 *       Reserves stock atomically (rejects if any line is short), dedupes the
 *       customer by phone, and issues a sequential order number. Category-less —
 *       items must be products of the given business.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/Order' }
 *           example:
 *             business: 60d0fe4f5311236168a109cc
 *             customerName: Sana
 *             contactNumber: "+923001234567"
 *             city: Lahore
 *             deliveryAddress: "House 1, Street 2"
 *             advanceAmount: 500
 *             courier: 60d0fe4f5311236168a109e0
 *             items:
 *               - { product: 60d0..., variantId: 60d0..., quantity: 2, unitPrice: 2500 }
 *     responses:
 *       201: { description: Order created }
 *       400: { description: Validation error or insufficient stock }
 *       403: { description: Not assigned to that business }
 */
router
  .route('/')
  .get(
    can('orders', 'read'),
    // Lean list: the cards show only #, tracking, status, item count, total and
    // payment. Full details (customer, items, courier, remittance) come from the
    // detail-by-id endpoint. Search still matches name/phone/tracking — that is
    // the query filter, independent of the projection.
    advancedResults(
      Order,
      null,
      ['orderNumber', 'customerName', 'contactNumber', 'trackingId'],
      'orderNumber trackingId status paymentStatus total itemCount'
    ),
    getOrders
  )
  .post(can('orders', 'create'), restrictBusinessToScope(), createOrder);

/**
 * @swagger
 * /orders/{id}:
 *   get:
 *     summary: Get single order
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: Order }
 *       404: { description: Not found, or outside your businesses }
 *   put:
 *     summary: Edit an order (only while pending/confirmed — before it ships)
 *     description: >
 *       Re-validates the lines, atomically re-reserves stock, and re-snapshots
 *       the items. Refused once the order is dispatched, delivered or paid —
 *       then history is fixed and you cancel/return instead.
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: Updated }
 *       400: { description: Not editable (already shipped/paid), or not enough stock }
 *       404: { description: Not found, or outside your businesses }
 */
router
  .route('/:id')
  .get(can('orders', 'read'), loadScoped(Order), getOrder)
  .put(can('orders', 'update'), loadScoped(Order), updateOrder);

/**
 * @swagger
 * /orders/{id}/status:
 *   put:
 *     summary: Change fulfillment status (may restock / book a return expense)
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               status: { type: string, enum: [confirmed, dispatched, delivered, cancelled, returned] }
 *               trackingId: { type: string, description: "Set at dispatch — the courier consignment number" }
 *               deliveryCharge: { type: number, description: "Captured at dispatch; reused on payment and booked as the return expense on a refusal" }
 *     responses:
 *       200: { description: Updated }
 *       400: { description: Illegal transition }
 */
/**
 * @swagger
 * /orders/{id}/exchange:
 *   post:
 *     summary: Exchange a delivered order for a replacement (return + new order)
 *     description: >
 *       Puts the original order's goods back, reverses its sale and refunds any
 *       COD, marks it "exchanged", and creates a linked replacement order for
 *       the new items. The price difference is the replacement's COD.
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [items]
 *             properties:
 *               items: { type: array, items: { $ref: '#/components/schemas/OrderItem' } }
 *               courier: { type: string }
 *     responses:
 *       201: { description: Replacement order created; original marked exchanged }
 *       400: { description: Not delivered, already exchanged, or not enough stock }
 *       404: { description: Not found, or outside your businesses }
 */
router.post('/:id/exchange', can('orders', 'update'), loadScoped(Order), exchangeOrder);

router.put('/:id/status', can('orders', 'update'), loadScoped(Order), updateOrderStatus);

/**
 * @swagger
 * /orders/{id}/payment:
 *   put:
 *     summary: Mark COD received / unpaid (independent of delivery status)
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               paymentStatus: { type: string, enum: [unpaid, paid] }
 *     responses:
 *       200: { description: Updated }
 *       400: { description: Only delivered orders can be marked paid }
 */
router.put('/:id/payment', can('orders', 'update'), loadScoped(Order), updateOrderPayment);

/**
 * @swagger
 * /orders/{id}/tracking:
 *   put:
 *     summary: Set or correct the courier tracking number
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               trackingId: { type: string, description: "Courier consignment number (empty to clear)" }
 *     responses:
 *       200: { description: Updated }
 */
router.put('/:id/tracking', can('orders', 'update'), loadScoped(Order), updateOrderTracking);

export default router;
