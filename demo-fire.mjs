/*
 * DEMO HELPER — fire a real notification on cue while you screen-record.
 *
 * Creates a genuine order in "Abgeen cosmetics", which triggers:
 *   • a live in-app toast + badge (websocket) in any open app tab, and
 *   • an OS push notification on every device that clicked "Enable".
 *
 * Usage (from the backend folder):
 *   node demo-fire.mjs        # fire one
 *   node demo-fire.mjs 3      # fire three, a couple seconds apart
 *
 * Clean up afterwards with:  node demo-cleanup.mjs
 */
import { readFileSync } from 'fs';

const env = Object.fromEntries(
  readFileSync('./.env', 'utf8')
    .split('\n')
    .filter(l => l.includes('='))
    .map(l => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const API = 'http://localhost:5000/api/v1';
const count = Math.max(1, Number(process.argv[2]) || 1);
const j = async r => ({ status: r.status, body: await r.json().catch(() => null) });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const login = await j(
  await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.SEED_ADMIN_EMAIL, password: env.SEED_ADMIN_PASSWORD })
  })
);
if (!login.body?.token) {
  console.error('Login failed — is the backend running?');
  process.exit(1);
}
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.body.token}` };

const biz = (
  await j(await fetch(`${API}/businesses?limit=20`, { headers: H })).then(r => r)
).body.data.find(b => b.name === 'Abgeen cosmetics');
const products = (
  await j(await fetch(`${API}/products?business=${biz._id}&limit=50`, { headers: H }))
).body.data;
const pick = products.find(p => (p.variants || []).some(v => v.stock > 0));
if (!pick) {
  console.error('No product with stock in Abgeen cosmetics — add stock first.');
  process.exit(1);
}
const variant = pick.variants.find(v => v.stock > 0);

for (let n = 1; n <= count; n++) {
  const order = await j(
    await fetch(`${API}/orders`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        business: biz._id,
        customerName: 'Demo Buyer',
        contactNumber: '03001110001',
        city: 'Lahore',
        deliveryAddress: 'Demo address',
        items: [{ product: pick._id, variantId: variant._id, quantity: 1, unitPrice: 1999 }]
      })
    })
  );
  if (order.status === 201) {
    console.log(
      `🔔 Fired notification: "New order #${order.body.data.orderNumber}" (${pick.name})`
    );
  } else {
    console.error('Order failed:', order.status, order.body?.error);
  }
  if (n < count) await sleep(2500);
}
console.log(
  '\nCheck the app (toast + bell badge) and your device (OS push). Clean up: node demo-cleanup.mjs'
);
