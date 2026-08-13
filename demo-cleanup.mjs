/*
 * DEMO CLEANUP — removes everything demo-fire.mjs created and restores stock,
 * so your data is exactly as it was before recording.
 *
 * Usage (from the backend folder):  node demo-cleanup.mjs
 */
import mongoose from 'mongoose';
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

await mongoose.connect(env.MONGODB_URI);
const db = mongoose.connection.db;

// Restore stock for each demo order, then delete it.
const orders = await db.collection('orders').find({ customerName: 'Demo Buyer' }).toArray();
for (const order of orders) {
  for (const it of order.items || []) {
    await db
      .collection('products')
      .updateOne(
        { _id: it.product, 'variants._id': it.variantId },
        { $inc: { 'variants.$.stock': it.quantity } }
      );
  }
}
const delOrders = await db.collection('orders').deleteMany({ customerName: 'Demo Buyer' });
const delCust = await db.collection('customers').deleteMany({ phone: '03001110001' });
const delNotes = await db.collection('notifications').deleteMany({ body: /Demo Buyer/ });

console.log(
  `Cleaned — orders: ${delOrders.deletedCount} (stock restored), customers: ${delCust.deletedCount}, notifications: ${delNotes.deletedCount}`
);
await mongoose.disconnect();
