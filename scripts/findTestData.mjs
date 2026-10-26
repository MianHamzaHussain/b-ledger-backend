/*
 * READ-ONLY: list records that look like test or demo data, so the owner can judge them.
 *
 *   npm run find:testdata
 *
 * It looks at names and notes (orders, customers, parties, products, businesses, users) for words like
 * "test", "demo", "dummy", "sample", "do not deliver", prints what it finds with the business and the
 * date, and changes NOTHING. A match is not proof — a customer really called Tester would match — it
 * is a short list to look at. Run it on the server against the real database before and after any
 * recording or test session.
 */
import mongoose from 'mongoose';

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGODB_URI is not set.');
  process.exit(1);
}

const WORDS = /(\btest\b|\btesting\b|\bdemo\b|dummy|\bsample\b|do not deliver|\bxxx\b|\basdf\b)/i;

const CHECKS = [
  {
    collection: 'orders',
    fields: ['customerName', 'customerNote', 'note', 'deliveryAddress'],
    show: 'orderNumber'
  },
  { collection: 'customers', fields: ['name', 'note'], show: 'phone' },
  { collection: 'parties', fields: ['name', 'note'], show: 'type' },
  { collection: 'products', fields: ['name'], show: 'articleNumber' },
  { collection: 'businesses', fields: ['name'], show: '_id' },
  { collection: 'users', fields: ['name', 'email'], show: 'email' }
];

await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
const db = mongoose.connection.db;
const host = new URL(uri.replace('mongodb+srv://', 'mongodb://')).host.split('@').pop();
console.log(`Looking in database "${db.databaseName}" on ${host} (read-only)\n`);

let total = 0;
for (const { collection, fields, show } of CHECKS) {
  const rows = await db
    .collection(collection)
    .find({ $or: fields.map(f => ({ [f]: WORDS })) })
    .limit(200)
    .toArray();
  if (!rows.length) continue;
  total += rows.length;
  console.log(`${collection}: ${rows.length}`);
  for (const r of rows.slice(0, 20)) {
    const what = fields
      .map(f => r[f])
      .filter(Boolean)
      .join(' | ');
    const when = r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : '';
    console.log(`  ${when}  ${show}=${r[show] ?? ''}  ${String(what).slice(0, 90)}`);
  }
  if (rows.length > 20) console.log(`  … and ${rows.length - 20} more`);
}
console.log(
  total
    ? `\n${total} record(s) to look at. Nothing was changed.`
    : 'Nothing that looks like test data.'
);
await mongoose.disconnect();
