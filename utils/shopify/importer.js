import Order from '../../models/Order.js';
import Customer from '../../models/Customer.js';
import Product from '../../models/Product.js';
import ShopifyHold from '../../models/ShopifyHold.js';
import ShopifyVariantLink from '../../models/ShopifyVariantLink.js';
import { createOrder, updateOrder } from '../../controllers/orderController.js';
import { callHandler } from '../callHandler.js';
import logger from '../logger.js';
import { notify } from '../notify.js';
import { normalizePhone } from '../phone.js';
import { pakistanDay } from '../pakistanDay.js';
import { NOTIFICATION_TYPES, ORDER_STATUS, SALES_CHANNELS } from '../constants.js';
import { mapOrder, problemsWith, sameText } from './mapper.js';

/**
 * Turn one Shopify order into B Ledger's. Everything an order normally does — holding stock, matching the customer,
 * the "new order" alert — is done by the existing create/edit handlers, so it cannot drift from the rules the rest
 * of the app follows. What is added here is only: matching Shopify's products to our stock, saying no safely, and
 * merging a second order from the same person (same number, same address, same day) into the first.
 */

/** Orders that have not had their confirmation call yet — the only ones another order may be merged into. */
const MERGEABLE = [ORDER_STATUS.CREATED, ORDER_STATUS.PENDING];

const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const plain = text =>
  String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

/** The one stock item whose name (and size) is exactly this Shopify line — or nothing, never a guess. */
const matchByName = async (business, line) => {
  if (!line.title) return null;
  const products = await Product.find({
    business,
    name: new RegExp(`^${escapeRegex(line.title)}$`, 'i')
  }).select('name variants');
  if (products.length !== 1) return null;

  const [product] = products;
  const wanted = plain(line.variantTitle);
  const isDefault = !wanted || wanted === 'default title';
  if (isDefault && product.variants.length === 1) {
    return { product: product._id, variantId: product.variants[0]._id };
  }
  const sized = product.variants.filter(v => plain(v.label) === wanted);
  return sized.length === 1 ? { product: product._id, variantId: sized[0]._id } : null;
};

/** The stock item for one Shopify line: a saved link first, then an exact name match (saved for next time). */
const resolveLine = async (business, line) => {
  if (line.variantId) {
    const link = await ShopifyVariantLink.findOne({ business, shopifyVariantId: line.variantId });
    if (link) {
      const stillThere = await Product.exists({
        _id: link.product,
        business,
        'variants._id': link.variantId
      });
      if (stillThere) return { product: link.product, variantId: link.variantId };
    }
  }
  const match = await matchByName(business, line);
  if (match && line.variantId) {
    await ShopifyVariantLink.updateOne(
      { business, shopifyVariantId: line.variantId },
      {
        $set: {
          shopifyProductId: line.productId ?? undefined,
          shopifyTitle: [line.title, line.variantTitle].filter(Boolean).join(' — '),
          product: match.product,
          variantId: match.variantId,
          madeBy: 'auto'
        }
      },
      { upsert: true }
    );
  }
  return match;
};

/** Keep an order that cannot be made by itself, with why, and tell people once. */
const holdOrder = async (business, node, mapped, reasons, unmatched) => {
  const before = await ShopifyHold.findOne({ business, shopifyOrderId: mapped.id });
  await ShopifyHold.updateOne(
    { business, shopifyOrderId: mapped.id },
    {
      $set: {
        name: mapped.name,
        shopifyCreatedAt: mapped.createdAt,
        customerName: mapped.customerName,
        reasons,
        unmatched,
        raw: node,
        status: 'open'
      }
    },
    { upsert: true }
  );
  if (!before || before.status !== 'open') {
    await notify({
      business,
      type: NOTIFICATION_TYPES.SHOPIFY_ATTENTION,
      title: `Shopify order #${mapped.name} needs attention`,
      body: reasons[0],
      link: '/integrations'
    });
  }
  return { result: 'held', reasons };
};

const createNew = async (connection, actor, mapped, items) => {
  const { body } = await callHandler(createOrder, {
    user: actor,
    body: {
      business: connection.business,
      customerName: mapped.customerName,
      contactNumber: mapped.phone,
      city: mapped.city,
      deliveryAddress: mapped.address,
      customerNote: mapped.note || undefined,
      shopifyOrderNumber: mapped.name,
      source: SALES_CHANNELS.SHOPIFY,
      // The Shopify order's own id: sending it twice can never make two orders.
      clientRef: `shopify:${mapped.id}`,
      items
    }
  });
  const order = body.data;
  await Order.updateOne(
    { _id: order._id },
    { $set: { shopifyOrderIds: [mapped.id], shopifyDay: pakistanDay(new Date(mapped.createdAt)) } },
    { timestamps: false }
  );
  return { result: 'created', orderId: order._id, orderNumber: order.orderNumber };
};

/** An order from the same person, to the same address, the same day, not yet called: this one joins it. */
const findMergeTarget = async (business, mapped) => {
  const customer = await Customer.findOne({ business, phone: normalizePhone(mapped.phone) });
  if (!customer) return null;
  const candidates = await Order.find({
    business,
    customer: customer._id,
    source: SALES_CHANNELS.SHOPIFY,
    status: { $in: MERGEABLE },
    shopifyDay: pakistanDay(new Date(mapped.createdAt))
  });
  return (
    candidates.find(
      o => sameText(o.deliveryAddress, mapped.address) && sameText(o.city, mapped.city)
    ) ?? null
  );
};

const mergeInto = async (actor, order, mapped, items) => {
  await callHandler(updateOrder, {
    user: actor,
    resource: order,
    body: {
      customerName: order.customerName,
      contactNumber: order.contactNumber,
      city: order.city,
      deliveryAddress: order.deliveryAddress,
      source: order.source,
      // "51486+51487" — every Shopify number the order was made from.
      shopifyOrderNumber: [order.shopifyOrderNumber, mapped.name].filter(Boolean).join('+'),
      items: [
        ...order.items.map(i => ({
          product: i.product,
          variantId: i.variantId,
          quantity: i.quantity,
          unitPrice: i.unitPrice
        })),
        ...items
      ],
      customWork: order.customWork.map(w => ({
        description: w.description,
        price: w.price,
        fromScratch: w.fromScratch
      }))
    }
  });
  await Order.updateOne(
    { _id: order._id },
    {
      $addToSet: { shopifyOrderIds: mapped.id },
      $push: {
        activity: {
          $each: [
            {
              kind: 'details',
              text: 'Another Shopify order was added to this order',
              to: `#${mapped.name}`,
              at: new Date(),
              system: true
            }
          ],
          $slice: -300
        }
      }
    },
    { timestamps: false }
  );
  await notify({
    business: order.business,
    type: NOTIFICATION_TYPES.NEW_ORDER,
    title: `New Shopify order added to #${order.orderNumber}`,
    body: `${order.customerName} · Shopify #${mapped.name}`,
    link: `/orders/${order._id}`
  });
  return { result: 'merged', orderId: order._id, orderNumber: order.orderNumber };
};

/**
 * Bring one Shopify order in. Returns what happened: `created`, `merged`, `held` (with the reasons), or `skipped`
 * (cancelled, before go-live, already brought in, or put aside by a person). Safe to call again with the same order.
 */
export const importOrder = async (connection, node, actor) => {
  const mapped = mapOrder(node);
  const business = connection.business;

  if (!mapped.id) return { result: 'skipped', reason: 'no id' };
  if (mapped.cancelled) return { result: 'skipped', reason: 'cancelled in Shopify' };
  if (new Date(mapped.createdAt) < connection.goLiveAt) {
    return { result: 'skipped', reason: 'placed before it was connected' };
  }
  if (await Order.exists({ business, shopifyOrderIds: mapped.id })) {
    return { result: 'skipped', reason: 'already brought in' };
  }
  const hold = await ShopifyHold.findOne({ business, shopifyOrderId: mapped.id });
  if (hold?.status === 'ignored') return { result: 'skipped', reason: 'put aside by a person' };

  const reasons = problemsWith(mapped);
  const items = [];
  const unmatched = [];
  for (const line of mapped.lines) {
    const found = await resolveLine(business, line);
    if (found) items.push({ ...found, quantity: line.quantity, unitPrice: line.unitPrice });
    else {
      unmatched.push({
        title: line.title,
        variantTitle: line.variantTitle,
        variantId: line.variantId ?? undefined,
        productId: line.productId ?? undefined
      });
    }
  }
  if (unmatched.length) {
    reasons.push(
      `${unmatched.length} item${unmatched.length === 1 ? '' : 's'} not matched to your stock yet`
    );
  }
  if (reasons.length) return holdOrder(business, node, mapped, reasons, unmatched);

  let out;
  try {
    const target = await findMergeTarget(business, mapped);
    out = target
      ? await mergeInto(actor, target, mapped, items)
      : await createNew(connection, actor, mapped, items);
  } catch (err) {
    // The order handlers refused (a blocked customer, a stock rule…): keep it for a person, with their words.
    logger.warn({ err: err.message, shopifyOrder: mapped.id }, 'shopify order held after an error');
    return holdOrder(business, node, mapped, [err.message || 'It could not be created'], []);
  }

  await ShopifyHold.updateOne(
    { business, shopifyOrderId: mapped.id, status: 'open' },
    { $set: { status: 'done', resolvedAt: new Date() }, $unset: { raw: 1 } }
  );
  return out;
};

/** After a person has matched a product: try every waiting order again (each is safe to repeat). */
export const retryHolds = async (connection, actor) => {
  const holds = await ShopifyHold.find({
    business: connection.business,
    status: 'open',
    raw: { $exists: true }
  });
  const tally = { created: 0, merged: 0, held: 0, skipped: 0 };
  for (const hold of holds) {
    const { result } = await importOrder(connection, hold.raw, actor);
    tally[result] += 1;
  }
  return tally;
};
