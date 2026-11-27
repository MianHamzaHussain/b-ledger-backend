import crypto from 'node:crypto';
import { reply } from './courier.js';
import { userId } from './db.js';
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
  ordersFail = false,
  webhookFail = false,
  // One-click (OAuth) connections: what the store grants, how long an access token lasts, and whether a renewal is refused.
  grantedScope = 'read_orders,read_customers',
  accessTtl = 3600,
  codeStatus = 200,
  refreshStatus = 200,
  // Runs in the middle of a renewal — to model another request renewing at the same moment.
  onRefresh
} = {}) => {
  const state = {
    orders,
    calls: [],
    tokenRequests: 0,
    orderQueries: 0,
    webhookCalls: 0,
    codeExchanges: [],
    refreshes: [],
    graphqlTokens: []
  };
  let rotation = 0;
  shopifyDeps.fetchImpl = async (url, init) => {
    const u = String(url);
    state.calls.push(u);
    const sent = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    if (u.includes('/admin/oauth/access_token') && sent?.code) {
      state.codeExchanges.push(sent);
      if (codeStatus !== 200) return reply({ error: 'invalid_request' }, codeStatus);
      rotation += 1;
      return reply({
        access_token: `at_${rotation}`,
        refresh_token: `rt_${rotation}`,
        scope: grantedScope,
        expires_in: accessTtl,
        refresh_token_expires_in: 7_776_000
      });
    }
    if (u.includes('/admin/oauth/access_token') && sent?.grant_type === 'refresh_token') {
      state.refreshes.push(sent);
      if (onRefresh) await onRefresh(sent);
      if (refreshStatus !== 200) return reply({ error: 'invalid_grant' }, refreshStatus);
      rotation += 1;
      return reply({
        access_token: `at_${rotation}`,
        refresh_token: `rt_${rotation}`,
        scope: grantedScope,
        expires_in: accessTtl,
        refresh_token_expires_in: 7_776_000
      });
    }
    if (u.includes('/graphql.json'))
      state.graphqlTokens.push(init?.headers?.['X-Shopify-Access-Token']);
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
        state.webhookCalls += 1;
        if (webhookFail) {
          return reply({
            data: {
              webhookSubscriptionCreate: {
                webhookSubscription: null,
                userErrors: [{ message: 'Address is not allowed' }]
              }
            }
          });
        }
        return reply({
          data: {
            webhookSubscriptionCreate: { webhookSubscription: { id: 'gid://x/1' }, userErrors: [] }
          }
        });
      }
      if (query.includes('orders(')) {
        state.orderQueries += 1;
        state.ordersQuery = query;
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

/** What a handler did to the response, for the pages that answer with redirects (the install trip) and the webhook. */
export const callHandler = async (handler, req = {}) => {
  const headers = Object.fromEntries(
    Object.entries(req.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])
  );
  const res = {
    statusCode: 200,
    redirectedTo: null,
    cookies: {},
    cleared: [],
    body: undefined,
    ended: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    redirect(target) {
      this.statusCode = 302;
      this.redirectedTo = target;
      return this;
    },
    cookie(name, value, options) {
      this.cookies[name] = { value, ...options };
      return this;
    },
    clearCookie(name) {
      this.cleared.push(name);
      return this;
    },
    get headersSent() {
      return this.ended || this.redirectedTo !== null || this.body !== undefined;
    }
  };
  const request = {
    user: { id: userId },
    query: {},
    body: {},
    cookies: {},
    ...req,
    get: name => headers[name.toLowerCase()]
  };
  // Done when the response is written AND the handler has finished (a webhook answers first, then works).
  await new Promise((resolve, reject) => {
    const next = err => reject(err instanceof Error ? err : new Error(String(err)));
    let answered;
    const wasAnswered = new Promise(done => {
      answered = done;
    });
    for (const method of ['end', 'json', 'redirect']) {
      const original = res[method].bind(res);
      res[method] = (...args) => {
        const out = original(...args);
        answered();
        return out;
      };
    }
    Promise.all([Promise.resolve(handler(request, res, next)), wasAnswered]).then(resolve, reject);
  });
  return res;
};

/** Shopify's signature on a redirect: the query without `hmac`, sorted, HMAC-SHA256 in hex. */
export const signQuery = (query, secret) => {
  const message = Object.entries(query)
    .filter(([key]) => key !== 'hmac')
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  return { ...query, hmac: crypto.createHmac('sha256', secret).update(message).digest('hex') };
};

/** Shopify's signature on a webhook: base64 HMAC-SHA256 over the exact bytes. */
export const signBody = (raw, secret) =>
  crypto.createHmac('sha256', secret).update(raw).digest('base64');
