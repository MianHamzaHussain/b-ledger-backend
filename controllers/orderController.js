import asyncHandler from '../middlewares/asyncHandler.js';
import ErrorResponse from '../utils/errorResponse.js';
import Order, { heldPaisaOf } from '../models/Order.js';
import Product from '../models/Product.js';
import Business from '../models/Business.js';
import Customer from '../models/Customer.js';
import Party from '../models/Party.js';
import JournalEntry from '../models/JournalEntry.js';
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
import { resolveMoney } from '../utils/moneyAccounts.js';
import {
  recordAdvance,
  recordRefund,
  removeCustomerMoney,
  keepAsCredit
} from '../utils/customerMoney.js';
import {
  recordCustomCost,
  recordCustomCostFromMaterial,
  removeCustomCost,
  moveCustomWipToCogs,
  writeOffCustomWip
} from '../utils/customCost.js';
import { upsertCustomerParty } from '../utils/customerParty.js';
import { refundQuote, refundReturn } from '../utils/refundReturn.js';
import { putScratchInStock, scratchLines, takeScratchBack } from '../utils/scratchStock.js';
import {
  assertExchangeable,
  convertSaleToCredit,
  receiveReturnedGoods,
  creditForReplacement,
  markCreditMoved
} from '../utils/exchange.js';
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
 *         figure is state-aware — before delivery the courier has not billed its
 *         fee (`deliveryKnown: false`), so it reads as an estimate; after
 *         delivery it is exact. It uses the same math the ledger posts, so the
 *         number on the detail is the number that will hit the books.
 * @route  GET /api/v1/orders/:id  (orders:read — scoped)
 */
export const getOrder = asyncHandler(async (req, res) => {
  const order = req.resource;
  await order.populate([
    { path: 'courier', select: 'name' },
    { path: 'customerParty', select: 'name phone' },
    { path: 'customer', select: 'name phone' },
    // The timeline names who made each change.
    { path: 'statusHistory.by', select: 'name' }
  ]);

  const codPaisa = toPaisa(order.codAmount);

  // A walk-in / counter sale has no courier: no delivery fee, no COD taxes — the
  // buyer simply owes the full balance, so the net receivable is the balance.
  // An order that merely hasn't been dispatched yet has no courier either, but it
  // will be collected on delivery — so it's a counter sale only if it came in as
  // a walk-in.
  let remittance;
  if (!order.courier && order.source === SALES_CHANNELS.WALK_IN) {
    // Part-payments made from the customer's party page come off what is owed.
    const paidPaisa = order.paidPaisa || 0;
    remittance = {
      codAmount: order.codAmount,
      deliveryCharge: 0,
      withholdingTax: 0,
      salesTax: 0,
      paidSoFar: fromPaisa(paidPaisa),
      netReceivable: fromPaisa(Math.max(0, codPaisa - paidPaisa)),
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
      // Before delivery the courier has not billed the fee, so the net is an
      // estimate; once paid the remittance is settled and the number is final.
      deliveryKnown: order.deliveryChargePaisa != null,
      settled: order.paymentStatus === PAYMENT_STATUS.PAID,
      counterSale: false
    };
  }

  // The courier's bill for bringing the parcel back (return / exchange pickup).
  const returnCharge =
    order.returnChargePaisa != null ? fromPaisa(order.returnChargePaisa) : undefined;

  res.status(200).json({ success: true, data: { ...order.toObject(), remittance, returnCharge } });
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
 * Validate order lines against a business's products and snapshot the name,
 * variant label and COST at order time (price is the negotiated input). Throws
 * a 400 on any bad line. Shared by create, edit and exchange — the three places
 * that build order lines.
 */
const buildLineItems = async (business, items) => {
  if (!items.length) return [];
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
  const customWork = req.body.customWork || [];
  const advanceAmount = Number(req.body.advanceAmount) || 0;

  if (!business) return next(new ErrorResponse('Please select a business', 400));
  if ((items?.length ?? 0) + customWork.length === 0)
    return next(new ErrorResponse('Add at least one item or custom work', 400));
  if (!customerName || !contactNumber) {
    return next(new ErrorResponse('Customer name and contact number are required', 400));
  }

  const biz = await Business.findById(business);
  if (!biz) return next(new ErrorResponse('Business not found', 404));
  // Where the advance (or counter payment) went — checked before anything is held.
  const advanceMoney =
    advanceAmount > 0
      ? await resolveMoney(business, { account: req.body.advanceAccount }, req.user)
      : null;

  // Courier is chosen at dispatch, not here — a walk-in/counter sale has none.
  const lineItems = await buildLineItems(business, items);

  // A walk-in / counter sale is handed over the moment it is rung up: it is born
  // DELIVERED, has no courier and no COD taxes, and `advanceAmount` is the cash
  // actually taken at the counter. Anything still owed is credit — sub-ledgered
  // to a named customer party, so we must know who owes it.
  const isWalkIn = source === SALES_CHANNELS.WALK_IN;
  const total =
    lineItems.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0) +
    customWork.reduce((s, w) => s + w.price, 0);
  // A reduction ("no dupatta") can lower the price, but never below nothing.
  if (total < 0) return next(new ErrorResponse("The order total can't be below 0", 400));
  const owed = Math.max(0, total - advanceAmount);
  if (advanceAmount > total) {
    return next(new ErrorResponse('The advance is more than the order total', 400));
  }
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

  let order;
  try {
    const customer = await Customer.findOneAndUpdate(
      { business, phone: contactNumber },
      {
        $set: { name: customerName, city },
        $setOnInsert: { business, phone: contactNumber, createdBy: req.user.id }
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );

    order = await Order.create({
      business,
      customer: customer._id,
      customerParty,
      source: source || undefined,
      customerName,
      contactNumber,
      city,
      deliveryAddress,
      items: lineItems,
      customWork,
      // A counter sale takes its payment in the sale; any other order's advance
      // is booked as it arrives (below), which also derives the COD.
      advanceAmount: isWalkIn ? advanceAmount : 0,
      counterAccount: isWalkIn ? advanceMoney?.account : undefined,
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
    } else if (advanceMoney) {
      await recordAdvance(order, {
        amount: advanceAmount,
        money: advanceMoney,
        userId: req.user.id
      });
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
    // Order creation failed after stock was reserved — give it back, and drop
    // an order whose advance couldn't be booked rather than leave it half-made.
    await releaseStock(lineItems);
    if (order && !order.saleEntry) await Order.deleteOne({ _id: order._id });
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
  const customWork = req.body.customWork || [];
  const business = order.business;

  if ((items?.length ?? 0) + customWork.length === 0)
    return next(new ErrorResponse('Add at least one item or custom work', 400));
  if (!customerName || !contactNumber) {
    return next(new ErrorResponse('Customer name and contact number are required', 400));
  }

  // Re-validate and re-snapshot the new lines against this business's products.
  const newItems = await buildLineItems(business, items);
  // Advances are money already booked — the new total can't drop below them.
  const newTotal =
    newItems.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0) +
    customWork.reduce((s, w) => s + w.price, 0);
  if (newTotal < 0) return next(new ErrorResponse("The order total can't be below 0", 400));
  if (order.advanceAmount > newTotal) {
    return next(
      new ErrorResponse(
        'The advance is more than the new total — refund part of it on the order first',
        400
      )
    );
  }

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
  order.customWork = customWork;
  order.updatedBy = req.user.id;
  await order.save();

  res.status(200).json({ success: true, data: order });
});

/** Book the pickup charge now, when the courier's bill is already known. */
const bookReturnCharge = async (order, returnCharge, userId) => {
  if (returnCharge == null) return;
  const returnChargePaisa = toPaisa(returnCharge);
  order.returnChargePaisa = returnChargePaisa;
  if (returnChargePaisa > 0) await postReturnCharge(order, fromPaisa(returnChargePaisa), userId);
};

/**
 * Create the replacement for an exchanged order — same customer, new items —
 * carrying the original's credit, so its COD is only the price difference.
 * Stock is reserved first, then `beforeCreate` runs (a swap turns the sale into
 * credit there); if anything fails the stock is given back and that step undone.
 */
const makeReplacement = async (original, body, userId, beforeCreate) => {
  const { items = [], customWork = [], courier } = body;
  const business = original.business;
  // The replacement inherits the original's courier unless a new one is chosen.
  const replacementCourier = courier ? await resolveCourier(business, courier) : original.courier;
  const newItems = await buildLineItems(business, items);
  const total =
    newItems.reduce((s, i) => s + i.unitPrice * i.quantity, 0) +
    customWork.reduce((s, w) => s + w.price, 0);
  if (total < 0) throw new ErrorResponse("The replacement total can't be below 0", 400);
  await reserveStock(newItems);
  let undo;
  try {
    undo = beforeCreate ? await beforeCreate() : null;
    const credit = creditForReplacement(original, userId);
    const replacement = await Order.create({
      business,
      customer: original.customer,
      courier: replacementCourier,
      source: original.source,
      // A replacement is a new order: the customer may have moved.
      customerName: body.customerName || original.customerName,
      contactNumber: body.contactNumber || original.contactNumber,
      city: body.city ?? original.city,
      deliveryAddress: body.deliveryAddress ?? original.deliveryAddress,
      items: newItems,
      customWork,
      customerMoney: credit ? [credit] : [],
      exchangeOf: original._id,
      isSwap: Boolean(body.isSwap),
      createdBy: userId
    });
    markCreditMoved(original, replacement, credit?.amountPaisa ?? 0, userId);
    return replacement;
  } catch (err) {
    await releaseStock(newItems);
    if (undo) await undo();
    throw err;
  }
};

/**
 * @desc   Exchange, return first: the old item is back. Its stock returns and its
 *         sale becomes the customer's credit, waiting for the replacement. The
 *         courier's COD, delivery charge and taxes stand — they happened.
 * @route  POST /api/v1/orders/:id/exchange-return  (orders:update — scoped)
 */
export const exchangeReturn = asyncHandler(async (req, res) => {
  const original = req.resource;
  assertExchangeable(original);

  await convertSaleToCredit(original, req.user.id);
  await receiveReturnedGoods(original, req.user.id);
  // The customer sent it back on their own courier, at their cost — it is never
  // on our invoice, so its charge is closed now rather than left open.
  original.returnShipping = { by: 'customer', courierName: req.body.returnCourierName };
  original.returnChargePaisa = 0;
  if (req.body.reversalTrackingId) original.reversalTrackingId = req.body.reversalTrackingId;
  original.$locals.statusNote = req.body.note;
  await original.save();

  res.status(200).json({ success: true, data: original });
});

/**
 * @desc   What a refund would normally keep back: delivery charge (if billed) + tax.
 * @route  GET /api/v1/orders/:id/refund-quote  (orders:read — scoped)
 */
export const getRefundQuote = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, data: await refundQuote(req.resource) });
});

/**
 * @desc   Delivered, then sent back for a refund: goods back in stock, the sale
 *         becomes what's owed back, less what's kept. Pay it with "Refund paid".
 * @route  POST /api/v1/orders/:id/refund-return  (orders:update — scoped)
 */
export const refundReturnOrder = asyncHandler(async (req, res) => {
  const order = req.resource;
  await refundReturn(order, req.body, req.user.id);
  order.$locals.statusNote = req.body.note;
  await order.save();
  res.status(200).json({ success: true, data: order });
});

/**
 * @desc   Exchange, step 2 of return first: send the replacement, carrying the credit.
 * @route  POST /api/v1/orders/:id/exchange-replacement  (orders:update — scoped)
 */
export const createReplacement = asyncHandler(async (req, res, next) => {
  const original = req.resource;
  if (original.status !== ORDER_STATUS.EXCHANGED) {
    return next(new ErrorResponse('Record the item coming back first', 400));
  }
  if (original.exchangedFor) {
    return next(new ErrorResponse('A replacement was already sent for this order', 400));
  }

  const replacement = await makeReplacement(original, req.body, req.user.id);
  await original.save();
  res.status(201).json({ success: true, data: replacement });
});

/**
 * @desc   Exchange, swap at the door: the replacement goes out now and the rider
 *         brings the old item back on the courier's reversal tracking number.
 *         The sale becomes credit at once (the replacement's COD needs it); the
 *         stock comes back when the old item is received.
 * @route  POST /api/v1/orders/:id/swap  (orders:update — scoped)
 */
export const swapOrder = asyncHandler(async (req, res, next) => {
  const original = req.resource;
  assertExchangeable(original);

  // The rider swaps at the door and collects nothing: whatever the replacement
  // costs beyond the customer's credit is paid to us directly, before it goes.
  const credit = heldPaisaOf(original) + toPaisa(original.codAmount);
  const newTotal =
    (await buildLineItems(original.business, req.body.items)).reduce(
      (s, i) => s + toPaisa(i.unitPrice) * i.quantity,
      0
    ) + (req.body.customWork || []).reduce((s, w) => s + toPaisa(w.price), 0);
  const differencePaisa = newTotal - credit;
  const differenceMoney =
    differencePaisa > 0
      ? req.body.differenceAccount
        ? await resolveMoney(original.business, { account: req.body.differenceAccount }, req.user)
        : null
      : null;
  if (differencePaisa > 0 && !differenceMoney) {
    return next(
      new ErrorResponse(
        'The customer pays the difference to you directly — choose where it came in',
        400
      )
    );
  }

  // Same courier as the original — it swaps both parcels in one visit.
  const body = { ...req.body, courier: undefined, isSwap: true };
  // The sale turns into credit only once the replacement stock is reserved, so
  // a shortfall leaves the original untouched.
  const replacement = await makeReplacement(original, body, req.user.id, async () => {
    const entry = await convertSaleToCredit(original, req.user.id);
    return entry
      ? () => reverseEntry(entry._id, { userId: req.user.id, memo: 'Swap not completed' })
      : null;
  });
  original.awaitingReturn = true;
  if (req.body.reversalTrackingId) original.reversalTrackingId = req.body.reversalTrackingId;
  original.$locals.statusNote = req.body.note;
  await original.save();

  // The difference, paid in directly: an advance on the replacement, so its COD is 0.
  if (differenceMoney) {
    await recordAdvance(replacement, {
      amount: fromPaisa(differencePaisa),
      money: differenceMoney,
      note: 'difference for the swap',
      userId: req.user.id
    });
  }

  res.status(201).json({ success: true, data: replacement });
});

/**
 * @desc   Swap at the door: the old item has arrived back — its stock returns.
 * @route  POST /api/v1/orders/:id/receive-return  (orders:update — scoped)
 */
export const receiveReturn = asyncHandler(async (req, res, next) => {
  const original = req.resource;
  if (!original.awaitingReturn) {
    return next(new ErrorResponse('This order is not waiting for an item to come back', 400));
  }
  await receiveReturnedGoods(original, req.user.id);
  await bookReturnCharge(original, req.body.returnCharge, req.user.id);
  if (req.body.reversalTrackingId) original.reversalTrackingId = req.body.reversalTrackingId;
  original.updatedBy = req.user.id;
  await original.save();

  res.status(200).json({ success: true, data: original });
});

/**
 * @desc   Advance the fulfillment status. Dispatch takes the courier and its
 *         tracking number; delivered/returned take the courier's final charge.
 *         Cancelling or returning restocks the items; a return also books its
 *         charge as an expense.
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

  // Dispatch hands the parcel to a courier (a courier-type party, which COD is
  // sub-ledgered to) and gets back a tracking number — both known right now.
  // The charge is NOT: the courier bills by weight, city and outcome, so it is
  // taken when the parcel lands (delivered / returned / exchanged) instead.
  if (status === ORDER_STATUS.DISPATCHED) {
    const courier = await resolveCourier(order.business, req.body.courier);
    // A swap goes with the courier that takes the old item back at the door.
    if (order.isSwap && order.courier && String(courier) !== String(order.courier)) {
      return next(
        new ErrorResponse('A swap goes with the same courier as the original order', 400)
      );
    }
    order.courier = courier;
    const trackingId = typeof req.body.trackingId === 'string' ? req.body.trackingId.trim() : '';
    if (!trackingId) return next(new ErrorResponse('Enter the courier tracking number', 400));
    order.trackingId = trackingId;
  }

  // The courier's charge is normally only known when its invoice arrives, so it
  // is optional here: left out, the charge stays open and is billed on the
  // courier invoice. Given (e.g. already on the courier's portal), it is booked
  // now, with 0 meaning "no charge".
  const isOutcome = status === ORDER_STATUS.DELIVERED || status === ORDER_STATUS.RETURNED;
  const chargeKnown = isOutcome && req.body.deliveryCharge !== undefined;
  const chargePaisa = chargeKnown ? toPaisa(req.body.deliveryCharge) : 0;

  if (status === ORDER_STATUS.DELIVERED && chargeKnown) {
    // The fee may exceed the COD — a fully prepaid parcel still costs a fee,
    // which the courier takes out of what it owes us on other orders.
    order.deliveryChargePaisa = chargePaisa;
  }

  // Leaving the flow into a terminal state returns the reserved stock.
  if (status === ORDER_STATUS.CANCELLED || status === ORDER_STATUS.RETURNED) {
    await releaseStock(order.items);
  }

  if (order.status === ORDER_STATUS.CANCELLED && status === ORDER_STATUS.PENDING) {
    // Its made-from-scratch pieces come back out of stock first — refused if one
    // was sold meanwhile, before anything else changes.
    await takeScratchBack(order, req.user.id);
    await reserveStock(order.items);
    if (order.customCostWriteOff) {
      await reverseEntry(order.customCostWriteOff, {
        userId: req.user.id,
        memo: `Reopen Custom WIP — order ${order.orderNumber}`
      });
      order.customCostWriteOff = undefined;
    }
  }

  // Delivery is where revenue and cost of goods are recognised (once).
  if (status === ORDER_STATUS.DELIVERED && !order.saleEntry) {
    const entry = await postOrderSale(order, req.user.id);
    if (entry) order.saleEntry = entry._id;
    await moveCustomWipToCogs(order, req.user.id);
  }

  // A return unwinds whatever was booked, and what the courier billed for the
  // refused parcel is a sunk cost — booked as an expense.
  if (status === ORDER_STATUS.RETURNED) {
    if (order.saleEntry) {
      await reverseEntry(order.saleEntry, {
        userId: req.user.id,
        memo: `Return of order ${order.orderNumber}`
      });
    }
    if (chargeKnown) {
      order.returnChargePaisa = chargePaisa;
      if (chargePaisa > 0) await postReturnCharge(order, fromPaisa(chargePaisa), req.user.id);
    }
  }

  // A made-from-scratch piece is still a finished piece: into stock, not a loss.
  // Other custom work (an alteration on a stock item) was spent — written off.
  if (status === ORDER_STATUS.CANCELLED || status === ORDER_STATUS.RETURNED) {
    if (scratchLines(order).length) {
      await putScratchInStock(order, req.body.scratchPieces, req.user.id);
    } else if (!order.customCostWriteOff) {
      const entry = await writeOffCustomWip(order, req.user.id);
      if (entry) order.customCostWriteOff = entry._id;
    }
  }

  order.status = status;
  order.updatedBy = req.user.id;
  // The optional reason ("customer refused", "cancelled on call") lands on the
  // timeline entry the model writes for this change.
  order.$locals.statusNote = req.body.note;
  await order.save();

  res.status(200).json({ success: true, data: order });
});

/**
 * @desc   Set the order's free note. Allowed at any status, even after dispatch
 *         or payment — it changes nothing but the note.
 * @route  PUT /api/v1/orders/:id/note  (orders:update — scoped)
 */
export const updateOrderNote = asyncHandler(async (req, res) => {
  const order = req.resource;

  order.note = req.body.note || undefined;
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
    // Without its delivery charge the net can't be known — the courier's invoice
    // is where both arrive together.
    if (order.courier && order.deliveryChargePaisa == null) {
      return next(new ErrorResponse("Record this parcel's payment on the courier's invoice", 400));
    }

    // Post the courier's remittance once — Bank in, delivery fee expensed. The
    // delivery charge was already captured at delivery, so we reuse it here
    // rather than asking again.
    if (!order.paymentEntry) {
      const deliveryCharge = fromPaisa(order.deliveryChargePaisa || 0);
      const entry = await postOrderRemittance(order, deliveryCharge, req.user.id);
      if (entry) order.paymentEntry = entry._id;
    }
    // A counter sale is now paid in full — what the party page collected plus
    // whatever this entry just booked.
    if (!order.courier) order.paidPaisa = toPaisa(order.codAmount);
  } else if (order.courierSettlement) {
    // Paid on a courier invoice — unmarking one order would leave the money
    // booked against the courier but the order unpaid.
    return next(
      new ErrorResponse(
        "This order was paid on a courier's invoice. Reverse that invoice instead.",
        400
      )
    );
  } else if (!order.courier && !order.paymentEntry && order.paidPaisa > 0) {
    // Paid through the customer's own account, not this button — undoing it
    // here would leave that money booked but the order unpaid.
    return next(
      new ErrorResponse(
        "This order was paid from the customer's account. Record a refund on their page instead.",
        400
      )
    );
  } else if (order.paymentEntry) {
    // A counter sale: only the part this entry booked comes off what was paid.
    if (!order.courier) {
      const entry = await JournalEntry.findById(order.paymentEntry).select('lines');
      const bookedPaisa = (entry?.lines || []).reduce((s, l) => s + (l.debitPaisa || 0), 0);
      order.paidPaisa = Math.max(0, (order.paidPaisa || 0) - bookedPaisa);
    }
    // Reversing to unpaid unwinds the remittance, but the delivery charge stays
    // — it belongs to the delivery, not the payment.
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

/** Where money came from / went, resolved for this order's business. */
const orderMoney = (order, req) =>
  resolveMoney(order.business, { account: req.body.account }, req.user);

/**
 * @desc   The customer sent money (a payment screenshot). Before dispatch it
 *         lowers the COD; after, the COD is fixed and it becomes a refund due.
 * @route  POST /api/v1/orders/:id/advances  (orders:update — scoped)
 */
export const addOrderAdvance = asyncHandler(async (req, res) => {
  const order = req.resource;
  const money = await orderMoney(order, req);
  const { amount, date, note } = req.body;
  await recordAdvance(order, { amount, money, date, note, userId: req.user.id });
  res.status(201).json({ success: true, data: order });
});

/**
 * @desc   Money paid back to the customer — at most what is due.
 * @route  POST /api/v1/orders/:id/refunds  (orders:update — scoped)
 */
export const addOrderRefund = asyncHandler(async (req, res) => {
  const order = req.resource;
  const money = await orderMoney(order, req);
  const { amount, date, note } = req.body;
  await recordRefund(order, { amount, money, date, note, userId: req.user.id });
  res.status(201).json({ success: true, data: order });
});

/**
 * @desc   Remove an advance or refund entered by mistake (its entry is reversed).
 * @route  DELETE /api/v1/orders/:id/customer-money/:rowId  (orders:update — scoped)
 */
export const deleteOrderMoney = asyncHandler(async (req, res) => {
  const order = req.resource;
  await removeCustomerMoney(order, req.params.rowId, req.user.id);
  res.status(200).json({ success: true, data: order });
});

/**
 * @desc   Keep a cancelled/returned order's refund due as credit on the customer's khata.
 * @route  POST /api/v1/orders/:id/credit  (orders:update — scoped)
 */
export const keepOrderCredit = asyncHandler(async (req, res) => {
  const order = req.resource;
  await keepAsCredit(order, { amount: req.body.amount, userId: req.user.id });
  res.status(201).json({ success: true, data: order });
});

/**
 * @desc   Add a material/labor cost to a custom order
 * @route  POST /api/v1/orders/:id/custom-cost
 */
export const addCustomCost = asyncHandler(async (req, res, next) => {
  const order = req.resource;

  if (order.status !== ORDER_STATUS.PENDING && order.status !== ORDER_STATUS.CONFIRMED) {
    return next(new ErrorResponse('Costs can only be added before the order is dispatched', 400));
  }

  const { description, amount, account, material, materialQty } = req.body;
  if (material) {
    await recordCustomCostFromMaterial(order, material, materialQty, req.user.id);
  } else {
    const money = await resolveMoney(order.business, { account }, req.user);
    await recordCustomCost(order, description, toPaisa(amount), money, req.user.id);
  }
  await order.save();

  res.status(200).json({ success: true, data: order });
});

/**
 * @desc   Remove a material/labor cost logged by mistake
 * @route  DELETE /api/v1/orders/:id/custom-cost/:costId
 */
export const deleteCustomCost = asyncHandler(async (req, res, next) => {
  const order = req.resource;

  if (order.status !== ORDER_STATUS.PENDING && order.status !== ORDER_STATUS.CONFIRMED) {
    return next(new ErrorResponse('Costs can only be removed before the order is dispatched', 400));
  }

  await removeCustomCost(order, req.params.costId, req.user.id);
  await order.save();

  res.status(200).json({ success: true, data: order });
});
