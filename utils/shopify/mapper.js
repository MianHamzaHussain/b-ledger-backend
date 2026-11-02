import { isMobile, normalizePhone } from '../phone.js';

/**
 * Shopify's order, as B Ledger needs it — and the reasons it can NOT be made into an order by itself.
 *
 * Pure (no database, no network). The rule behind `problemsWith`: an order is brought in automatically only when it
 * is what the shop's day-to-day order is — cash on delivery, a customer name, a mobile number, an address and city,
 * items we can name, and a total that is exactly the sum of its items. Anything else is held for a person with the
 * reason, because a wrong guess here becomes a wrong parcel and wrong money.
 */

/** Shopify's ids are "gid://shopify/Order/123": the numeric tail is what we keep. */
export const idOf = gid => {
  const tail = String(gid ?? '')
    .split('/')
    .pop();
  return tail || null;
};

const money = set => Number(set?.shopMoney?.amount ?? 0) || 0;

const isCashOnDelivery = names =>
  (names ?? []).some(n => /cash on delivery|\bcod\b/i.test(String(n)));

/** What GraphQL returns for one order → the plain shape the importer works with. */
export const mapOrder = node => {
  const ship = node.shippingAddress ?? {};
  const customer = node.customer ?? {};
  const fullName = [customer.firstName, customer.lastName].filter(Boolean).join(' ');

  const lines = (node.lineItems?.nodes ?? []).map(line => ({
    title: String(line.title ?? '').trim(),
    variantTitle: String(line.variantTitle ?? '').trim(),
    variantId: line.variant?.id ? idOf(line.variant.id) : null,
    productId: line.product?.id ? idOf(line.product.id) : null,
    sku: String(line.sku ?? '').trim(),
    quantity: Number(line.quantity) || 0,
    unitPrice: money(line.originalUnitPriceSet)
  }));

  return {
    id: idOf(node.id),
    name: String(node.name ?? '').replace(/^#/, ''),
    createdAt: node.createdAt,
    cancelled: Boolean(node.cancelledAt),
    customerName: String(ship.name || fullName || '').trim(),
    phone: String(ship.phone || customer.phone || node.phone || '').trim(),
    email: customer.email ?? '',
    city: String(ship.city ?? '').trim(),
    address: [ship.address1, ship.address2]
      .filter(Boolean)
      .map(s => String(s).trim())
      .join(', '),
    note: String(node.note ?? '').trim(),
    lines,
    total: money(node.currentTotalPriceSet),
    shipping: money(node.totalShippingPriceSet),
    discounts: money(node.totalDiscountsSet),
    cashOnDelivery: isCashOnDelivery(node.paymentGatewayNames),
    gateways: node.paymentGatewayNames ?? []
  };
};

/** The reasons this order cannot be brought in by itself, in plain words. Empty = go ahead. */
export const problemsWith = mapped => {
  const why = [];
  if (!mapped.lines.length) why.push('The order has no items');
  if (mapped.lines.some(l => !(l.quantity >= 1))) why.push('An item has no quantity');
  if (!mapped.customerName) why.push('No customer name');
  if (!isMobile(normalizePhone(mapped.phone))) {
    why.push(
      mapped.phone ? 'The phone number is not a Pakistani mobile number' : 'No phone number'
    );
  }
  if (!mapped.address) why.push('No delivery address');
  if (!mapped.city) why.push('No city');
  if (!mapped.cashOnDelivery) {
    why.push(
      `Not cash on delivery (${mapped.gateways.join(', ') || 'no payment method'}) — record the payment by hand`
    );
  }
  if (mapped.shipping > 0) why.push('The order has a shipping charge — add it by hand');
  if (mapped.discounts > 0) why.push('The order has a discount — check the price by hand');

  const itemsTotal = mapped.lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
  if (mapped.lines.length && Math.abs(itemsTotal - mapped.total) > 1) {
    why.push(`The total (Rs ${mapped.total}) is not the items' sum (Rs ${itemsTotal})`);
  }
  return why;
};

/** Compare addresses and cities the way a person would: case, spaces and punctuation do not matter. */
export const sameText = (a, b) => {
  const plain = s =>
    String(s ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
  return plain(a) !== '' && plain(a) === plain(b);
};
