import { reply } from './courier.js';
import { shopifyDeps } from '../../utils/shopify/client.js';

/**
 * A fake Shopify: it hands out a token, answers the shop and orders queries, and accepts a webhook — and nothing in
 * the suite can reach a real store. `fake.orders` can be changed between calls, like orders being placed.
 */
export const fakeShopify = ({
  orders = [],
  tokenStatus = 200,
  tokenBody,
  shopName = 'Test Store ',
  ordersFail = false
} = {}) => {
  const state = { orders, calls: [], tokenRequests: 0 };
  shopifyDeps.fetchImpl = async (url, init) => {
    const u = String(url);
    state.calls.push(u);
    if (u.includes('/admin/oauth/access_token')) {
      state.tokenRequests += 1;
      if (tokenStatus !== 200) return reply(tokenBody ?? {}, tokenStatus);
      return reply({
        access_token: 'tok_123',
        scope: 'write_orders,read_products',
        expires_in: 86399
      });
    }
    if (u.includes('/graphql.json')) {
      const { query } = JSON.parse(init.body);
      if (query.includes('webhookSubscriptionCreate')) {
        return reply({
          data: {
            webhookSubscriptionCreate: { webhookSubscription: { id: 'gid://x/1' }, userErrors: [] }
          }
        });
      }
      if (query.includes('orders(')) {
        if (ordersFail) return reply({}, 503);
        return reply({
          data: {
            orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: state.orders }
          }
        });
      }
      if (query.includes('shop {')) return reply({ data: { shop: { name: shopName } } });
    }
    return reply({}, 404);
  };
  return state;
};

export const restoreShopify = () => {
  shopifyDeps.fetchImpl = (...args) => fetch(...args);
};

let serial = 51_000;
/** One Shopify order in the shape GraphQL returns it — a cash-on-delivery order of one item, by default. */
export const orderNode = ({
  number = (serial += 1),
  title = 'BEIGE MEHFIL',
  variantTitle = 'M',
  variantId = `gid://shopify/ProductVariant/${number}01`,
  quantity = 1,
  price = 16000,
  total,
  phone = '0300 1234567',
  name = 'Arham Ali',
  address = 'House 190, Block B',
  city = 'Lahore',
  gateways = ['Cash on Delivery (COD)'],
  shipping = 0,
  discounts = 0,
  createdAt = new Date().toISOString(),
  cancelledAt = null,
  lines
} = {}) => ({
  id: `gid://shopify/Order/${number}`,
  name: `#${number}`,
  createdAt,
  cancelledAt,
  note: null,
  phone: null,
  displayFinancialStatus: 'PENDING',
  paymentGatewayNames: gateways,
  currentTotalPriceSet: { shopMoney: { amount: String(total ?? price * quantity) } },
  totalShippingPriceSet: { shopMoney: { amount: String(shipping) } },
  totalDiscountsSet: { shopMoney: { amount: String(discounts) } },
  customer: {
    firstName: name.split(' ')[0],
    lastName: name.split(' ').slice(1).join(' '),
    phone: null,
    email: 'a@b.pk'
  },
  shippingAddress: {
    name,
    phone,
    address1: address,
    address2: null,
    city,
    province: 'Punjab',
    zip: '54000'
  },
  lineItems: {
    nodes: lines ?? [
      {
        title,
        variantTitle,
        sku: '',
        quantity,
        originalUnitPriceSet: { shopMoney: { amount: String(price) } },
        variant: { id: variantId },
        product: { id: `gid://shopify/Product/${number}` }
      }
    ]
  }
});
