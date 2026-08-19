import asyncHandler from '../middlewares/asyncHandler.js';
import ErrorResponse from '../utils/errorResponse.js';
import Order from '../models/Order.js';
import Product from '../models/Product.js';
import Business from '../models/Business.js';
import Customer from '../models/Customer.js';
import Party from '../models/Party.js';
import { reserveStock, releaseStock } from '../utils/stock.js';
import { createCrudHandlers } from '../utils/crudController.js';
import { reverseEntry } from '../utils/ledger.js';
import {
  postOrderSale,
  postOrderRemittance,
  postReturnCharge,
  computeRemittance
} from '../utils/orderPosting.js';
import { notify } from '../utils/notify.js';
import { toPaisa, fromPaisa } from '../utils/money.js';
import logger from '../utils/logger.js';
import {
  ORDER_STATUS,
  ORDER_TRANSITIONS,
  PAYMENT_STATUS,
  PARTY_TYPES,
  SALES_CHANNELS,
  NOTIFICATION_TYPES
} from '../utils/constants.js';

/**
 * Raise a low-stock alert for any ordered variant now at/below its threshold.
 * A notification is an **optional side effect** (CLAUDE.md §5.4), so this must
 * never throw — it runs after the order is created, and a failure here must not
 * roll back a good order.
 */
const notifyLowStock = async (business, lineItems) => {
  try {
    const productIds = [...new Set(lineItems.map(i => String(i.product)))];
    const products = await Product.find({ _id: { $in: productIds } }).select(
      'name lowStockThreshold variants'
    );

    for (const product of products) {
      if (!product.lowStockThreshold) continue;
      for (const line of lineItems) {
        if (String(line.product) !== String(product._id)) continue;
        const variant = product.variants.id(line.variantId);
        if (variant && variant.stock <= product.lowStockThreshold) {
          await notify({
            business,
            type: NOTIFICATION_TYPES.LOW_STOCK,
            title: `Low stock: ${product.name}`,
            body: `${variant.label || 'Default'} — ${variant.stock} left`,
            link: '/products'
          });
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'low-stock alert failed');
  }
};

const base = createCrudHandlers({
  model: Order,
  populate: [
    { path: 'courier', select: 'name' },
    { path: 'customer', select: 'name phone' }
  ]
});

/**
 * @route  GET /api/v1/orders      (orders:read — scoped)
 * @route  GET /api/v1/orders/:id  (orders:read — scoped)
 */
export const getOrders = base.getAll;

/**
 * @desc   One order, with a remittance preview: what the merchant actually
 *         banks once the courier deducts its fee and withholds FBR taxes. The
 *         figure is state-aware — before dispatch the delivery fee is not yet
 *         known (`deliveryKnown: false`), so it reads as an estimate; after
 *         dispatch it is exact. It uses the same math the ledger posts, so the
 *         number on the detail is the number that will hit the books.
 * @route  GET /api/v1/orders/:id  (orders:read — scoped)
 */
export const getOrder = asyncHandler(async (req, res) => {
  const order = req.resource;
  await order.populate([
    { path: 'courier', select: 'name' },
    { path: 'customerParty', select: 'name phone' },
    { path: 'customer', select: 'name phone' }
  ]);

  const codPaisa = toPaisa(order.codAmount);

  // A walk-in / counter sale has no courier: no delivery fee, no COD taxes — the
  // buyer simply owes the full balance, so the net receivable is the balance.
  let remittance;
  if (!order.courier) {
    remittance = {
      codAmount: order.codAmount,
      deliveryCharge: 0,
      withholdingTax: 0,
      salesTax: 0,
      netReceivable: order.codAmount,
      whtIsAsset: false,
      deliveryKnown: true,
      settled: order.paymentStatus === PAYMENT_STATUS.PAID,
      // Flag the counter-sale case so the client can label it "owed by customer".
      counterSale: true
    };
  } else {
    const business = await Business.findById(order.business).select('codTax');
    const parts = computeRemittance(
      codPaisa,
      order.deliveryChargePaisa || 0,
      business?.codTax || {}
    );
    remittance = {
      codAmount: order.codAmount,
      deliveryCharge: fromPaisa(parts.deliveryPaisa),
      withholdingTax: fromPaisa(parts.whtPaisa),
      salesTax: fromPaisa(parts.salesTaxPaisa),
      netReceivable: fromPaisa(parts.bankPaisa),
      // Registered ⇒ the WHT is a reclaimable asset, not a permanent cost.
      whtIsAsset: parts.whtIsAsset,
      // Before dispatch the courier has not yet quoted the fee, so the net is an
      // estimate; once paid the remittance is settled and the number is final.
      deliveryKnown: order.deliveryChargePaisa != null,
      settled: order.paymentStatus === PAYMENT_STATUS.PAID,
      counterSale: false
    };
  }

  res.status(200).json({ success: true, data: { ...order.toObject(), remittance } });
});

/**
 * Resolve and validate the order's courier — a Party of type `courier` for the
 * business. Required. Throws 400 if missing or not a courier party here. Shared
 * by create, edit and exchange.
 */
const resolveCourier = async (business, courierId) => {
  if (!courierId) throw new ErrorResponse('Please choose a courier', 400);
  const party = await Party.findOne({ _id: courierId, business, type: PARTY_TYPES.COURIER });
  if (!party) throw new ErrorResponse('That courier is not a courier party of this business', 400);
  return party._id;
};

/**
 * Resolve and validate a walk-in buyer's Party — a `customer`-type Party for the
 * business — so an unpaid counter sale's balance can be sub-ledgered to a name.
 * Required only when the sale is left unpaid. Throws 400 if missing or wrong.
 */
const resolveCustomerParty = async (business, partyId) => {
  if (!partyId) throw new ErrorResponse('Choose the customer this credit is owed by', 400);
  const party = await Party.findOne({ _id: partyId, business, type: PARTY_TYPES.CUSTOMER });
  if (!party)
    throw new ErrorResponse('That customer is not a customer party of this business', 400);
  return party._id;
};

/**
 * Create a customer party straight from the details already on the order (its
 * name + contact number), so an unpaid walk-in never re-asks for them. Upserts
 * by phone within the business so a repeat credit buyer folds into one running
 * account rather than spawning a duplicate statement each visit.
 */
const upsertCustomerParty = async (business, name, phone, userId) => {
  if (!phone)
    throw new ErrorResponse('A contact number is required to record a customer on credit', 400);
  // Bake the phone into the party name — a common first name ("Ali") stays
  // distinguishable everywhere the party is shown by name alone. Phone is still
  // kept as its own field so dedup-by-phone and phone search keep working.
  const label = `${name} - ${phone}`;
  const party = await Party.findOneAndUpdate(
    { business, type: PARTY_TYPES.CUSTOMER, phone },
    {
      $set: { name: label },
      $setOnInsert: { business, type: PARTY_TYPES.CUSTOMER, phone, createdBy: userId }
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  );
  return party._id;
};

/**
 * Validate order lines against a business's products and snapshot the name,
 * variant label and COST at order time (price is the negotiated input). Throws
 * a 400 on any bad line. Shared by create, edit and exchange — the three places
 * that build order lines.
 */
const buildLineItems = async (business, items) => {
  const lineItems = [];
  for (const it of items) {
    const product = await Product.findOne({ _id: it.product, business });
    if (!product) throw new ErrorResponse('A selected product is not in this business', 400);

    const variant = product.variants.id(it.variantId);
    if (!variant) throw new ErrorResponse(`Variant not found for ${product.name}`, 400);

    const quantity = Number(it.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new ErrorResponse('Quantity must be a whole number of at least 1', 400);
    }
    const unitPrice = Number(it.unitPrice);
    if (!(unitPrice >= 0)) throw new ErrorResponse('Price must be 0 or more', 400);

    lineItems.push({
      product: product._id,
      variantId: variant._id,
      productName: product.name,
      variantLabel: variant.label || 'Default',
      quantity,
      unitPrice,
      unitCost: variant.costPrice
    });
  }
  return lineItems;
};

/**
 * @desc   Create an order: snapshot lines, reserve stock atomically, dedupe the
 *         customer, and issue a sequential number.
 * @route  POST /api/v1/orders  (orders:create)
 */
export const createOrder = asyncHandler(async (req, res, next) => {
  const { business, customerName, contactNumber, city, deliveryAddress, source, items } = req.body;
  const advanceAmount = Number(req.body.advanceAmount) || 0;

  if (!business) return next(new ErrorResponse('Please select a business', 400));
  if (!Array.isArray(items) || items.length === 0) {
    return next(new ErrorResponse('Add at least one item', 400));
  }
  if (!customerName || !contactNumber) {
    return next(new ErrorResponse('Customer name and contact number are required', 400));
  }

  const biz = await Business.findById(business);
  if (!biz) return next(new ErrorResponse('Business not found', 404));

  // Courier is chosen at dispatch, not here — a walk-in/counter sale has none.
  const lineItems = await buildLineItems(business, items);

  // A walk-in / counter sale is handed over the moment it is rung up: it is born
  // DELIVERED, has no courier and no COD taxes, and `advanceAmount` is the cash
  // actually taken at the counter. Anything still owed is credit — sub-ledgered
  // to a named customer party, so we must know who owes it.
  const isWalkIn = source === SALES_CHANNELS.WALK_IN;
  const total = lineItems.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
  const owed = Math.max(0, total - advanceAmount);
  let customerParty;
  if (isWalkIn && owed > 0) {
    if (req.body.customerParty) {
      // An existing customer was picked from the search.
      customerParty = await resolveCustomerParty(business, req.body.customerParty);
    } else if (req.body.newCustomerParty) {
      // "New customer" was ticked — build one from the order's own details.
      customerParty = await upsertCustomerParty(business, customerName, contactNumber, req.user.id);
    } else {
      return next(
        new ErrorResponse(
          'Choose the customer this balance is owed by, or add them as a new customer',
          400
        )
      );
    }
  }

  // Atomic reserve — throws (and unwinds itself) if any line lacks stock.
  await reserveStock(lineItems);

  try {
    const customer = await Customer.findOneAndUpdate(
      { business, phone: contactNumber },
      {
        $set: { name: customerName, city },
        $setOnInsert: { business, phone: contactNumber, createdBy: req.user.id }
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );

    const order = await Order.create({
      business,
      customer: customer._id,
      customerParty,
      source: source || undefined,
      customerName,
      contactNumber,
      city,
      deliveryAddress,
      items: lineItems,
      advanceAmount,
      status: isWalkIn ? ORDER_STATUS.DELIVERED : undefined,
      paymentStatus: isWalkIn && owed <= 0 ? PAYMENT_STATUS.PAID : undefined,
      createdBy: req.user.id
    });

    // A counter sale is delivered on creation, so recognise the sale + COGS now
    // (the delivery transition that normally does this never happens for it).
    if (isWalkIn) {
      const entry = await postOrderSale(order, req.user.id);
      if (entry) {
        order.saleEntry = entry._id;
        await order.save();
      }
    }

    // Ambient alerts — must never fail the order.
    await notify({
      business,
      type: NOTIFICATION_TYPES.NEW_ORDER,
      title: `New order #${order.orderNumber}`,
      body: `${customerName} · Rs ${order.total}`,
      link: '/orders'
    });
    await notifyLowStock(business, lineItems);

    res.status(201).json({ success: true, data: order });
  } catch (err) {
    // Order creation failed after stock was reserved — give it back.
    await releaseStock(lineItems);
    next(err);
  }
});

/**
 * @desc   Edit an order before it ships. Allowed only while it is still
 *         `pending`/`confirmed` — stock is held but nothing has posted to the
 *         ledger yet. Once dispatched, delivered or paid, history is fixed and
 *         the honest correction is cancel/return, never a silent edit.
 * @route  PUT /api/v1/orders/:id  (orders:update — scoped)
 */
export const updateOrder = asyncHandler(async (req, res, next) => {
  const order = req.resource;

  const EDITABLE = [ORDER_STATUS.PENDING, ORDER_STATUS.CONFIRMED];
  if (!EDITABLE.includes(order.status)) {
    return next(
      new ErrorResponse(
        'Only orders that have not been dispatched can be edited. Cancel or return it instead.',
        400
      )
    );
  }
  // Belt and suspenders: never edit anything already posted to the books.
  if (order.saleEntry || order.paymentEntry) {
    return next(
      new ErrorResponse('This order has posted accounting entries and can not be edited.', 400)
    );
  }

  const { customerName, contactNumber, city, deliveryAddress, source, items } = req.body;
  const advanceAmount = Number(req.body.advanceAmount) || 0;
  const business = order.business;

  if (!Array.isArray(items) || items.length === 0) {
    return next(new ErrorResponse('Add at least one item', 400));
  }
  if (!customerName || !contactNumber) {
    return next(new ErrorResponse('Customer name and contact number are required', 400));
  }

  // Re-validate and re-snapshot the new lines against this business's products.
  const newItems = await buildLineItems(business, items);

  // Stock reconciliation on a transaction-less DB: free the old reservation,
  // take the new one. If the new one can't be met, restore the old exactly and
  // reject — never leave a partial deduction (backend CLAUDE.md §5.3.2).
  const oldItems = order.items.map(i => ({
    product: i.product,
    variantId: i.variantId,
    quantity: i.quantity
  }));
  await releaseStock(oldItems);
  try {
    await reserveStock(newItems);
  } catch (err) {
    await reserveStock(oldItems); // roll back to the pre-edit reservation
    return next(err);
  }

  // Phone is the customer identity — a changed number re-points to (or creates)
  // the right contact, mirroring createOrder.
  const customer = await Customer.findOneAndUpdate(
    { business, phone: contactNumber },
    {
      $set: { name: customerName, city },
      $setOnInsert: { business, phone: contactNumber, createdBy: req.user.id }
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  );

  order.customer = customer._id;
  if (source) order.source = source;
  order.customerName = customerName;
  order.contactNumber = contactNumber;
  order.city = city;
  order.deliveryAddress = deliveryAddress;
  order.items = newItems;
  order.advanceAmount = advanceAmount;
  order.updatedBy = req.user.id;
  await order.save();

  res.status(200).json({ success: true, data: order });
});

/**
 * @desc   Exchange a delivered order: put its goods back and reverse its sale
 *         (refunding any COD), then create a linked replacement order for the
 *         new items. The price difference is simply the replacement's COD —
 *         more if the new items cost more, less (a refund) if they cost less.
 * @route  POST /api/v1/orders/:id/exchange  (orders:update — scoped)
 */
export const exchangeOrder = asyncHandler(async (req, res, next) => {
  const original = req.resource;

  // Exchange means the customer already has the goods, so it only applies once
  // the order is delivered — and never twice.
  if (original.status !== ORDER_STATUS.DELIVERED) {
    return next(new ErrorResponse('Only a delivered order can be exchanged.', 400));
  }
  if (original.exchangedFor) {
    return next(new ErrorResponse('This order has already been exchanged.', 400));
  }

  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return next(new ErrorResponse('Add at least one replacement item', 400));
  }

  const business = original.business;
  // The replacement inherits the original's courier unless a new one is chosen.
  const courier = req.body.courier
    ? await resolveCourier(business, req.body.courier)
    : original.courier;

  const newItems = await buildLineItems(business, items);

  // Reserve the replacement stock first — if it can't be met, nothing has
  // changed yet and we simply reject.
  await reserveStock(newItems);

  try {
    // Unwind the original: goods back to inventory, sale reversed, COD refunded.
    await releaseStock(original.items);
    if (original.saleEntry) {
      await reverseEntry(original.saleEntry, {
        userId: req.user.id,
        memo: `Exchange of order ${original.orderNumber}`
      });
    }
    if (original.paymentEntry) {
      await reverseEntry(original.paymentEntry, {
        userId: req.user.id,
        memo: `Refund on exchange — order ${original.orderNumber}`
      });
    }

    // The replacement — same customer, new items, linked back to the original.
    const replacement = await Order.create({
      business,
      customer: original.customer,
      courier,
      source: original.source,
      customerName: original.customerName,
      contactNumber: original.contactNumber,
      city: original.city,
      deliveryAddress: original.deliveryAddress,
      items: newItems,
      exchangeOf: original._id,
      createdBy: req.user.id
    });

    original.status = ORDER_STATUS.EXCHANGED;
    original.exchangedFor = replacement._id;
    original.updatedBy = req.user.id;
    await original.save();

    res.status(201).json({ success: true, data: replacement });
  } catch (err) {
    // Failed after reserving the replacement stock — give it back and restore
    // the original's reservation (standalone DB, unwound by hand).
    await releaseStock(newItems);
    await reserveStock(original.items).catch(() => {});
    next(err);
  }
});

/**
 * @desc   Advance the fulfillment status. Cancelling or returning restocks the
 *         items; a return also books the return delivery charge as an expense.
 * @route  PUT /api/v1/orders/:id/status  (orders:update — scoped)
 */
export const updateOrderStatus = asyncHandler(async (req, res, next) => {
  const order = req.resource;
  const { status } = req.body;

  if (!Object.values(ORDER_STATUS).includes(status)) {
    return next(new ErrorResponse('Invalid status', 400));
  }
  if (!(ORDER_TRANSITIONS[order.status] || []).includes(status)) {
    return next(new ErrorResponse(`Cannot change status from ${order.status} to ${status}`, 400));
  }

  // A paid order is money in hand for goods the customer kept — it can never be
  // returned. (The transition table already prevents this, but the rule is
  // important enough to state and enforce explicitly.)
  if (status === ORDER_STATUS.RETURNED && order.paymentStatus === PAYMENT_STATUS.PAID) {
    return next(
      new ErrorResponse(
        'A paid order can not be returned — a return only applies to a parcel the customer refused.',
        400
      )
    );
  }

  // Dispatch is where the courier is chosen (a courier-type party) and quotes the
  // delivery charge. Both are captured here and reused when the remittance is
  // booked on payment; COD is sub-ledgered to this courier.
  if (status === ORDER_STATUS.DISPATCHED) {
    order.courier = await resolveCourier(order.business, req.body.courier);
    const deliveryCharge = Number(req.body.deliveryCharge) || 0;
    if (deliveryCharge < 0)
      return next(new ErrorResponse('Delivery charge can not be negative', 400));
    if (toPaisa(deliveryCharge) > toPaisa(order.codAmount)) {
      return next(new ErrorResponse('Delivery charge can not exceed the COD amount', 400));
    }
    order.deliveryChargePaisa = toPaisa(deliveryCharge);
  }

  // Leaving the flow into a terminal state returns the reserved stock.
  if (status === ORDER_STATUS.CANCELLED || status === ORDER_STATUS.RETURNED) {
    await releaseStock(order.items);
  }

  // Delivery is where revenue and cost of goods are recognised (once).
  if (status === ORDER_STATUS.DELIVERED && !order.saleEntry) {
    const entry = await postOrderSale(order, req.user.id);
    if (entry) order.saleEntry = entry._id;
  }

  // A return unwinds whatever was booked. The courier's forward delivery charge
  // was already captured at dispatch (a return is only reachable from
  // dispatched), so it is a sunk cost — book it as an expense automatically
  // rather than asking for it again.
  if (status === ORDER_STATUS.RETURNED) {
    if (order.saleEntry) {
      await reverseEntry(order.saleEntry, {
        userId: req.user.id,
        memo: `Return of order ${order.orderNumber}`
      });
    }
    const chargePaisa = order.deliveryChargePaisa || 0;
    if (chargePaisa > 0) await postReturnCharge(order, fromPaisa(chargePaisa), req.user.id);
  }

  // The courier assigns a tracking number at dispatch — capture it in the same
  // step so a parcel can be scanned back to this order later.
  if (typeof req.body.trackingId === 'string') {
    order.trackingId = req.body.trackingId.trim();
  }

  order.status = status;
  order.updatedBy = req.user.id;
  await order.save();

  res.status(200).json({ success: true, data: order });
});

/**
 * @desc   Set or correct the courier tracking number after dispatch.
 * @route  PUT /api/v1/orders/:id/tracking  (orders:update — scoped)
 */
export const updateOrderTracking = asyncHandler(async (req, res, next) => {
  const order = req.resource;

  order.trackingId = typeof req.body.trackingId === 'string' ? req.body.trackingId.trim() : '';
  order.updatedBy = req.user.id;
  await order.save();

  res.status(200).json({ success: true, data: order });
});

/**
 * @desc   Mark COD received (or reverse it) — independent of delivery status.
 * @route  PUT /api/v1/orders/:id/payment  (orders:update — scoped)
 */
export const updateOrderPayment = asyncHandler(async (req, res, next) => {
  const order = req.resource;
  const { paymentStatus } = req.body;

  if (!Object.values(PAYMENT_STATUS).includes(paymentStatus)) {
    return next(new ErrorResponse('Invalid payment status', 400));
  }

  if (paymentStatus === PAYMENT_STATUS.PAID) {
    // You can only be paid for something that was actually delivered.
    if (order.status !== ORDER_STATUS.DELIVERED) {
      return next(new ErrorResponse('Only delivered orders can be marked paid', 400));
    }

    // Post the courier's remittance once — Bank in, delivery fee expensed. The
    // delivery charge was already captured at dispatch, so we reuse it here
    // rather than asking again.
    if (!order.paymentEntry) {
      const deliveryCharge = fromPaisa(order.deliveryChargePaisa || 0);
      const entry = await postOrderRemittance(order, deliveryCharge, req.user.id);
      if (entry) order.paymentEntry = entry._id;
    }
  } else if (order.paymentEntry) {
    // Reversing to unpaid unwinds the remittance, but the delivery charge stays
    // — it belongs to the dispatch, not the payment.
    await reverseEntry(order.paymentEntry, {
      userId: req.user.id,
      memo: `Reverse COD — order ${order.orderNumber}`
    });
    order.paymentEntry = undefined;
  }

  order.paymentStatus = paymentStatus;
  order.updatedBy = req.user.id;
  await order.save();

  if (paymentStatus === PAYMENT_STATUS.PAID) {
    await notify({
      business: order.business,
      type: NOTIFICATION_TYPES.ORDER_PAID,
      title: `Order #${order.orderNumber} paid`,
      body: `Rs ${order.codAmount} received`,
      link: '/orders'
    });
  }

  res.status(200).json({ success: true, data: order });
});

/**
 * @desc   The last price a product/variant sold at, to prefill the form.
 * @route  GET /api/v1/orders/price-hint?product=&variantId=  (orders:read — scoped)
 */
export const getPriceHint = asyncHandler(async (req, res) => {
  const { product, variantId } = req.query;
  if (!product || !variantId) {
    return res.status(200).json({ success: true, data: { lastPrice: null } });
  }

  const order = await Order.findOne({
    ...req.accessFilter,
    'items.product': product,
    'items.variantId': variantId
  })
    .sort('-createdAt')
    .select('items');

  const line = order?.items.find(
    i => String(i.product) === String(product) && String(i.variantId) === String(variantId)
  );

  res.status(200).json({ success: true, data: { lastPrice: line ? line.unitPrice : null } });
});
