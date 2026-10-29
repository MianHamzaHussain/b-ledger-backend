import express from 'express';
import { protect } from '../middlewares/auth.js';
import {
  can,
  loadScoped,
  restrictBusinessToScope,
  hideCosts,
  requirePermission
} from '../middlewares/permissions.js';
import advancedResults from '../middlewares/advancedResults.js';
import { validate } from '../middlewares/validate.js';
import {
  orderCreateSchema,
  orderUpdateSchema,
  orderStatusSchema,
  orderPaymentSchema,
  orderExchangeReturnSchema,
  orderRefundReturnSchema,
  orderSwapSchema,
  orderReplacementSchema,
  orderTrackingSchema,
  orderAttemptSchema,
  orderNoteSchema,
  orderCustomerNoteSchema,
  orderShopifyNumberSchema,
  orderBookedForSchema,
  orderCourierConfirmSchema,
  orderLoadSheetSchema,
  orderMoneySchema,
  orderCreditSchema,
  customCostSchema
} from '../schemas/orders.js';
import Order from '../models/Order.js';
import { ORDER_LIST_FIELDS } from '../utils/orderListFields.js';
import {
  getOrders,
  getOrder,
  createOrder,
  updateOrder,
  exchangeReturn,
  getRefundQuote,
  refundReturnOrder,
  createReplacement,
  swapOrder,
  receiveReturn,
  updateOrderStatus,
  updateOrderPayment,
  updateOrderTracking,
  addDeliveryAttempt,
  updateOrderNote,
  updateOrderCustomerNote,
  updateOrderShopifyNumber,
  updateOrderBookedFor,
  addOrderAdvance,
  addOrderRefund,
  deleteOrderMoney,
  getPriceHint,
  getOrderSummary,
  getCourierReady,
  getDeliverers,
  getAirwayBill,
  refreshCourierStatus,
  getCourierParcels,
  getParcelPreview,
  getLoadSheet,
  cancelCourierParcel,
  confirmCourierStatus,
  keepOrderCredit,
  addCustomCost,
  deleteCustomCost
} from '../controllers/orderController.js';

const router = express.Router();

router.use(protect);
// Order lines carry the cost snapshot — only people who may "See costs" get it.
router.use(hideCosts);

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
 * /orders/summary:
 *   get:
 *     summary: Today's parcel counts (dispatched, delivered, pending) and every status's count
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: business, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: "{ createdToday, dispatchedToday, deliveredToday, pending, byStatus }" }
 *       404: { description: Outside your assigned businesses }
 */
router.get('/summary', can('orders', 'read'), getOrderSummary);

/**
 * @swagger
 * /orders/courier-ready:
 *   get:
 *     summary: Parcels the courier reports as delivered or returned, waiting to be confirmed
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: business, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: "{ data: [{ _id, orderNumber, customerName, kind, fee, ... }] }" }
 *       404: { description: Outside your assigned businesses }
 */
router.get('/courier-ready', can('orders', 'read'), getCourierReady);

/**
 * @swagger
 * /orders/load-sheet:
 *   post:
 *     summary: A courier load sheet (PDF) for parcels handed to the rider
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: A PDF }
 *       400: { description: None of the orders was booked through that courier }
 */
router.post(
  '/load-sheet',
  can('orders', 'update'),
  restrictBusinessToScope(),
  validate(orderLoadSheetSchema),
  getLoadSheet
);

/**
 * @swagger
 * /orders/deliverers:
 *   get:
 *     summary: Names already used as "delivered by" (newest first, up to 20)
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: business, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Array of names }
 *       404: { description: Outside your assigned businesses }
 */
router.get('/deliverers', can('orders', 'read'), getDeliverers);

/**
 * @swagger
 * /orders/confirm-courier:
 *   post:
 *     summary: Confirm, in one go, the orders the courier reports as delivered or returned
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [business, orderIds]
 *             properties:
 *               business: { type: string }
 *               orderIds: { type: array, items: { type: string }, maxItems: 50 }
 *     responses:
 *       200: { description: "{ confirmed, results: [{ id, ok, status | reason }] }" }
 *       403: { description: Not assigned to that business }
 */
router.post(
  '/confirm-courier',
  can('orders', 'update'),
  restrictBusinessToScope(),
  validate(orderCourierConfirmSchema),
  confirmCourierStatus
);

/**
 * @swagger
 * /orders/{id}/airway-bill:
 *   get:
 *     summary: The courier's airway bill PDF for an order booked through its service
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: A PDF }
 *       400: { description: The order was not booked through a courier service }
 *       502: { description: The courier refused or could not be reached }
 */
router.get('/:id/airway-bill', can('orders', 'read'), loadScoped(Order), getAirwayBill);

/**
 * @swagger
 * /orders/{id}/courier-refresh:
 *   post:
 *     summary: Ask the courier about this parcel now and apply its answer
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: The order with its fresh courier status }
 *       400: { description: Not a dispatched parcel booked through a courier }
 */
router.post(
  '/:id/courier-refresh',
  can('orders', 'update'),
  loadScoped(Order),
  refreshCourierStatus
);

/**
 * @swagger
 * /orders/{id}/courier-cancel:
 *   post:
 *     summary: Cancel a booked parcel at the courier before pickup; back to Confirmed (reopen) or returned with no charge
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema: { type: object, properties: { reopen: { type: boolean, description: "true = back to Confirmed, tracking cleared, ready to book again" } } }
 *     responses:
 *       200: { description: The order (Confirmed when reopen, otherwise Returned) }
 *       400: { description: Not a dispatched courier-booked parcel }
 *       502: { description: The courier refused (for example, already picked up) }
 */
/**
 * @swagger
 * /orders/{id}/courier-parcels:
 *   get:
 *     summary: Parcels already made on the courier's site for this order's customer
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *       - { in: query, name: courier, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: "[{ trackingNumber, orderRefNumber, cityName, invoicePayment }]" }
 */
router.get('/:id/courier-parcels', can('orders', 'read'), loadScoped(Order), getCourierParcels);

/**
 * @swagger
 * /orders/{id}/parcel-preview:
 *   get:
 *     summary: What the courier would receive if this order were booked now (sends nothing)
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *       - { in: query, name: courier, required: true, schema: { type: string } }
 *       - { in: query, name: remarks, schema: { type: string, maxLength: 250 } }
 *     responses:
 *       200: { description: "{ contents, remarks, phone, city, amount, pieces, pickup, problems[] }" }
 *       400: { description: The courier is not connected }
 */
router.get('/:id/parcel-preview', can('orders', 'update'), loadScoped(Order), getParcelPreview);

router.post('/:id/courier-cancel', can('orders', 'update'), loadScoped(Order), cancelCourierParcel);

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
 *       - { in: query, name: "createdAt[gte]",   schema: { type: string, format: date-time }, description: "Date range on any of createdAt / dispatchedAt / deliveredAt, with [gte] and [lte]" }
 *       - { in: query, name: "deliveredAt[lte]", schema: { type: string, format: date-time } }
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
 *             customerNote: "Gift pack, call before delivery"
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
    // Lean list: the cards show who it's for, #, today's serial, tracking, status, what was
    // ordered (names only), item count, total and payment. Full details (items, courier, remittance)
    // come from the detail-by-id endpoint. Search still matches name/phone/
    // tracking — that is the query filter, independent of the projection.
    advancedResults(
      Order,
      null,
      [
        'orderNumber',
        'customerName',
        'contactNumber',
        'trackingId',
        'reversalTrackingId',
        'shopifyOrderNumber',
        'deliveredBy'
      ],
      ORDER_LIST_FIELDS
    ),
    getOrders
  )
  .post(
    can('orders', 'create'),
    restrictBusinessToScope(),
    validate(orderCreateSchema),
    createOrder
  );

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
  .put(can('orders', 'update'), loadScoped(Order), validate(orderUpdateSchema), updateOrder);

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
 *               trackingId: { type: string, description: "Required on dispatched — the courier consignment number" }
 *               note: { type: string, description: "Optional reason, shown on the order's timeline (max 300)" }
 *               deliveryCharge: { type: number, description: "Required on delivered (the delivery fee — on a prepaid order it comes off the courier's COD balance) and returned (the return fee, booked as an expense). 0 if none." }
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
 *             required: [items, returnCharge]
 *             properties:
 *               items: { type: array, items: { $ref: '#/components/schemas/OrderItem' } }
 *               courier: { type: string }
 *               returnCharge: { type: number, description: "What the courier billed to collect the original parcel (0 if none) — booked as an expense" }
 *     responses:
 *       201: { description: Replacement order created; original marked exchanged }
 *       400: { description: Not delivered, already exchanged, or not enough stock }
 *       404: { description: Not found, or outside your businesses }
 */
/**
 * @swagger
 * /orders/{id}/refund-return:
 *   post:
 *     summary: Delivered, then sent back for a refund — goods back, money owed back less what's kept
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Order now refunded; pay it with Refund paid }
 */
router.get('/:id/refund-quote', can('orders', 'read'), loadScoped(Order), getRefundQuote);
router.post(
  '/:id/refund-return',
  can('orders', 'update'),
  loadScoped(Order),
  validate(orderRefundReturnSchema),
  refundReturnOrder
);

router.post(
  '/:id/exchange-return',
  can('orders', 'update'),
  loadScoped(Order),
  validate(orderExchangeReturnSchema),
  exchangeReturn
);

router.post(
  '/:id/exchange-replacement',
  can('orders', 'update'),
  loadScoped(Order),
  validate(orderReplacementSchema),
  createReplacement
);

/**
 * @openapi
 * /orders/{id}/swap:
 *   post:
 *     summary: Exchange by swapping at the door — the replacement goes out now
 *     description: >
 *       The original's sale becomes the customer's credit, which the replacement
 *       carries (its COD is the price difference). The old item comes back on the
 *       courier's reversal tracking number; its stock returns on receive-return.
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses:
 *       201: { description: The replacement order }
 * /orders/{id}/receive-return:
 *   post:
 *     summary: Swap at the door — the old item has arrived back (stock returns)
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: The original order }
 */
router.post(
  '/:id/swap',
  can('orders', 'update'),
  loadScoped(Order),
  validate(orderSwapSchema),
  swapOrder
);
router.post(
  '/:id/receive-return',
  can('orders', 'update'),
  loadScoped(Order),
  validate(orderExchangeReturnSchema),
  receiveReturn
);

/**
 * @openapi
 * /orders/{id}/attempts:
 *   post:
 *     summary: Log a failed delivery attempt on a parcel that is still out
 *     description: >
 *       Only a dispatched parcel. Changes no status and books nothing; it lets the
 *       courier report tell a first-time delivery from one that took several tries.
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reason]
 *             properties:
 *               reason: { type: string, enum: [not-available, refused, wrong-address, unreachable, other] }
 *               note: { type: string, maxLength: 200 }
 *     responses:
 *       201: { description: The order, with the attempt added }
 *       400: { description: Not a dispatched parcel, or an unknown reason }
 */
router.post(
  '/:id/attempts',
  can('orders', 'update'),
  loadScoped(Order),
  validate(orderAttemptSchema),
  addDeliveryAttempt
);

router.put(
  '/:id/status',
  can('orders', 'update'),
  loadScoped(Order),
  validate(orderStatusSchema),
  updateOrderStatus
);

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
router.put(
  '/:id/payment',
  can('orders', 'update'),
  loadScoped(Order),
  validate(orderPaymentSchema),
  updateOrderPayment
);

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
router.put(
  '/:id/tracking',
  can('orders', 'update'),
  loadScoped(Order),
  validate(orderTrackingSchema),
  updateOrderTracking
);

/**
 * @swagger
 * /orders/{id}/booked-for:
 *   put:
 *     summary: Move a booked order's due day (only while it is booked)
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [bookedFor]
 *             properties:
 *               bookedFor: { type: string, description: "A Pakistan day, YYYY-MM-DD, not in the past" }
 *     responses:
 *       200: { description: Updated }
 *       400: { description: Not booked, or the day has passed }
 */
router.put(
  '/:id/booked-for',
  can('orders', 'update'),
  loadScoped(Order),
  validate(orderBookedForSchema),
  updateOrderBookedFor
);

/**
 * @swagger
 * /orders/{id}/shopify-number:
 *   put:
 *     summary: Set the Shopify store's number for the order (any status — reference only)
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               shopifyOrderNumber: { type: string, description: "As Shopify shows it, e.g. 12355 (empty to clear)" }
 *     responses:
 *       200: { description: Updated }
 */
router.put(
  '/:id/shopify-number',
  can('orders', 'update'),
  loadScoped(Order),
  validate(orderShopifyNumberSchema),
  updateOrderShopifyNumber
);

/**
 * @swagger
 * /orders/{id}/customer-note:
 *   put:
 *     summary: Set the customer's request on the order (any status — changes nothing else)
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               customerNote: { type: string, description: "The customer's request, max 500 (empty to clear)" }
 *     responses:
 *       200: { description: Updated }
 */
router.put(
  '/:id/customer-note',
  can('orders', 'update'),
  loadScoped(Order),
  validate(orderCustomerNoteSchema),
  updateOrderCustomerNote
);

/**
 * @swagger
 * /orders/{id}/note:
 *   put:
 *     summary: Set the order's note (any status — changes nothing else)
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               note: { type: string, description: "Free text, max 1000 (empty to clear)" }
 *     responses:
 *       200: { description: Updated }
 */
router.put(
  '/:id/note',
  can('orders', 'update'),
  loadScoped(Order),
  validate(orderNoteSchema),
  updateOrderNote
);

/**
 * @openapi
 * /orders/{id}/advances:
 *   post:
 *     summary: Record an advance the customer sent (booked the same day)
 *     description: Before dispatch it lowers the COD. After dispatch the COD is fixed, so it becomes a refund due.
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [amount, account]
 *             properties:
 *               amount: { type: number }
 *               account: { type: string, description: "A money account id, or partner:<id>" }
 *               date: { type: string, format: date }
 *               note: { type: string }
 *     responses:
 *       201: { description: The order, with its customer money and refund due }
 * /orders/{id}/refunds:
 *   post:
 *     summary: Record money paid back to the customer (at most the refund due)
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses:
 *       201: { description: The order }
 * /orders/{id}/customer-money/{rowId}:
 *   delete:
 *     summary: Remove an advance or refund entered by mistake (reverses its entry)
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: The order }
 */
router.post(
  '/:id/advances',
  can('orders', 'update'),
  loadScoped(Order),
  validate(orderMoneySchema),
  addOrderAdvance
);
router.post(
  '/:id/refunds',
  can('orders', 'update'),
  loadScoped(Order),
  validate(orderMoneySchema),
  addOrderRefund
);
router.delete(
  '/:id/customer-money/:rowId',
  can('orders', 'update'),
  loadScoped(Order),
  deleteOrderMoney
);

/**
 * @swagger
 * /orders/{id}/credit:
 *   post:
 *     summary: Keep a cancelled/returned order's refund due as credit on the customer's khata
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [amount]
 *             properties:
 *               amount: { type: number }
 *     responses:
 *       201: { description: The order }
 */
router.post(
  '/:id/credit',
  can('orders', 'update'),
  loadScoped(Order),
  validate(orderCreditSchema),
  keepOrderCredit
);

router.post(
  '/:id/custom-cost',
  can('orders', 'update'),
  requirePermission('costs', 'read'),
  loadScoped(Order),
  validate(customCostSchema),
  addCustomCost
);

router.delete(
  '/:id/custom-cost/:costId',
  can('orders', 'update'),
  requirePermission('costs', 'read'),
  loadScoped(Order),
  deleteCustomCost
);

export default router;
