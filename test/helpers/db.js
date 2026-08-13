import mongoose from 'mongoose';
import Business from '../../models/Business.js';
import Product from '../../models/Product.js';
import Party from '../../models/Party.js';
import { ensureChart } from '../../utils/chartOfAccounts.js';

/**
 * Tests run against a real Mongo with a throwaway database — set MONGO_TEST_URI
 * in CI (a service container); locally it defaults to a `b_ledger_test` DB on
 * the dev server. mongodb-memory-server would be nicer for isolation but can't
 * download its binary in this environment, and a dedicated test DB is just as
 * safe as long as the suite runs serially (`--test-concurrency=1`).
 */
const uri = process.env.MONGO_TEST_URI || 'mongodb://127.0.0.1:27017/b_ledger_test';

export const oid = () => new mongoose.Types.ObjectId();
export const userId = oid();

export async function connect() {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  }
}

export async function clear() {
  const { collections } = mongoose.connection;
  for (const key of Object.keys(collections)) await collections[key].deleteMany({});
}

export async function disconnect() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
}

/** A business with its chart seeded. Pass `{ codTax }` for COD-tax tests. */
export async function makeBusiness(extra = {}) {
  const biz = await Business.create({
    name: 'Test Biz',
    category: oid(),
    createdBy: userId,
    ...extra
  });
  await ensureChart(biz._id);
  return biz;
}

export const makeProduct = (business, variants) =>
  Product.create({
    business,
    category: oid(),
    name: 'Test Product',
    createdBy: userId,
    variants: variants || [{ label: 'M', costPrice: 1000, salePrice: 2000, stock: 50 }]
  });

export const makeParty = (business, type, extra = {}) =>
  Party.create({ business, name: `Test ${type}`, type, createdBy: userId, ...extra });

/**
 * Run an Express controller against mock req/res. Resolves `{ status, body }`
 * on `res.json`, rejects if the handler calls `next(err)` — so a controller's
 * guard clause surfaces as a rejected promise the test can assert on.
 */
export const runHandler = (handler, req = {}) =>
  new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ status: this.statusCode, body });
      }
    };
    const next = err => reject(err instanceof Error ? err : new Error(err?.message || String(err)));
    Promise.resolve(handler({ user: { id: userId }, ...req }, res, next)).catch(reject);
  });
