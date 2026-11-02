/*
 * THROWAWAY — a read-only look at what a Shopify store gives the app. Delete it after the spike.
 *
 *   1. Put SHOPIFY_SHOP (subdomain only), SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET in backend/.env (gitignored).
 *   2. node --env-file=.env scripts/shopifyProbe.mjs
 *
 * It asks for a token, reads the shop and the newest orders, and prints which fields are PRESENT (yes/no) —
 * never a customer's name, phone or address, and never the secret or the token. It changes nothing in Shopify.
 */
const shop = (process.env.SHOPIFY_SHOP ?? '')
  .trim()
  .replace(/^https?:\/\//, '')
  .replace(/\.myshopify\.com.*$/, '');
const id = (process.env.SHOPIFY_CLIENT_ID ?? '').trim();
const secret = (process.env.SHOPIFY_CLIENT_SECRET ?? '').trim();
const version = (process.env.SHOPIFY_API_VERSION ?? '2026-07').trim() || '2026-07';

const yes = v => (v ? 'yes' : 'NO');

/** Return instead of process.exit(): exiting while a connection is still closing crashes Node on Windows. */
async function main() {
  if (!shop || !id || !secret) {
    console.error(
      'Set SHOPIFY_SHOP, SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET in backend/.env first.'
    );
    process.exitCode = 1;
    return;
  }
  console.log(`Asking https://${shop}.myshopify.com (from SHOPIFY_SHOP)`);

  const tokenRes = await fetch(`https://${shop}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: id,
      client_secret: secret
    })
  });
  const tokenBody = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenBody.access_token) {
    const why = String(tokenBody.error_description ?? tokenBody.error ?? 'no detail');
    console.error(`Token request failed (HTTP ${tokenRes.status}): ${why}`);
    if (tokenRes.status === 404) {
      console.error(
        'Shopify does not know that store address. SHOPIFY_SHOP must be only the myshopify subdomain of the store,'
      );
      console.error(
        'e.g. for admin.shopify.com/store/my-shop use  my-shop  (no https://, no .myshopify.com, no spaces).'
      );
    } else if (/shop_not_permitted/.test(why)) {
      console.error(
        'The app and this store are not in the same Shopify organization (the quick route cannot be used for this store).'
      );
    } else if (tokenRes.status === 400 || tokenRes.status === 401) {
      console.error(
        'Shopify rejected the id or secret: SHOPIFY_CLIENT_ID must be the Client ID and SHOPIFY_CLIENT_SECRET the Client secret'
      );
      console.error(
        '(Dev Dashboard -> your app -> Settings), and the app must be installed on this store.'
      );
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `Token OK. Lasts ${tokenBody.expires_in} seconds. Scopes granted: ${tokenBody.scope}`
  );

  const gql = async query => {
    const res = await fetch(`https://${shop}.myshopify.com/admin/api/${version}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': tokenBody.access_token
      },
      body: JSON.stringify({ query })
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, ...json };
  };

  const shopInfo = await gql('{ shop { name currencyCode ianaTimezone } }');
  console.log(
    `API version ${version}: HTTP ${shopInfo.status}`,
    shopInfo.data?.shop ?? shopInfo.errors ?? ''
  );

  const orders = await gql(`{
    orders(first: 10, reverse: true) {
      nodes {
        name
        createdAt
        displayFinancialStatus
        displayFulfillmentStatus
        paymentGatewayNames
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        totalShippingPriceSet { shopMoney { amount } }
        totalDiscountsSet { shopMoney { amount } }
        customer { firstName lastName phone email }
        shippingAddress { name phone address1 city province zip }
        phone
        lineItems(first: 20) { nodes { title variantTitle sku quantity variant { id } product { id } } }
      }
    }
  }`);

  if (orders.errors) {
    console.log('GraphQL errors (these often mean a permission or protected-data problem):');
    for (const e of orders.errors) console.log(' -', e.message);
  }
  const nodes = orders.data?.orders?.nodes ?? [];
  console.log(`\nOrders read: ${nodes.length}`);
  for (const o of nodes) {
    const items = o.lineItems?.nodes ?? [];
    console.log(
      `${o.name} | ${o.createdAt.slice(0, 10)} | ${o.displayFinancialStatus}/${o.displayFulfillmentStatus} | gateway: ${(o.paymentGatewayNames ?? []).join(',') || '-'} | total: ${o.currentTotalPriceSet?.shopMoney?.amount} ${o.currentTotalPriceSet?.shopMoney?.currencyCode}`
    );
    console.log(
      `   name (shipping): ${yes(o.shippingAddress?.name)} | customer name: ${yes(o.customer?.firstName)} | phone (customer): ${yes(o.customer?.phone)} | phone (shipping): ${yes(o.shippingAddress?.phone)} | phone (order): ${yes(o.phone)} | address: ${yes(o.shippingAddress?.address1)} | city: ${yes(o.shippingAddress?.city)} | email: ${yes(o.customer?.email)}`
    );
    console.log(
      `   items: ${items.length} | with title: ${items.filter(i => i.title).length} | with variant title: ${items.filter(i => i.variantTitle).length} | with SKU: ${items.filter(i => i.sku).length} | with variant id: ${items.filter(i => i.variant?.id).length} | shipping ${o.totalShippingPriceSet?.shopMoney?.amount ?? '?'} | discounts ${o.totalDiscountsSet?.shopMoney?.amount ?? '?'}`
    );
  }

  const hooks = await gql('{ webhookSubscriptions(first: 20) { nodes { topic } } }');
  const topics = (hooks.data?.webhookSubscriptions?.nodes ?? []).map(n => n.topic).join(', ');
  console.log(
    '\nWebhook subscriptions the app can see:',
    hooks.errors ? hooks.errors.map(e => e.message).join('; ') : topics || 'none'
  );
}

await main();
