import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
// Every business-scoped model must be registered before the registry below is read; keep this
// list in step with models/ — test/systemReset.test.js fails if one is missing.
import '../models/Account.js';
import '../models/Consignment.js';
import '../models/CourierInvoice.js';
import '../models/Customer.js';
import '../models/GoodsReceipt.js';
import '../models/JournalEntry.js';
import '../models/Material.js';
import '../models/MaterialMove.js';
import '../models/Notification.js';
import '../models/Order.js';
import '../models/Partner.js';
import '../models/Party.js';
import '../models/PeriodLock.js';
import '../models/Product.js';
import '../models/ProductionBatch.js';

/** Plain words for the reset screen — keyed by model name. */
const LABELS = {
  Account: 'money accounts',
  Consignment: 'sale-or-return handovers',
  CourierInvoice: 'courier invoices',
  Customer: 'customers',
  GoodsReceipt: 'goods received',
  JournalEntry: 'money entries',
  Material: 'materials',
  MaterialMove: 'material movements',
  Notification: 'notifications',
  Order: 'orders',
  Partner: 'partners',
  Party: 'khata people',
  PeriodLock: 'period locks',
  Product: 'articles',
  ProductionBatch: 'production batches'
};

/**
 * Every model that belongs to a business — read from the model registry, not a hand-kept
 * list, so a new business-scoped model is wiped (and counted) without anyone remembering.
 */
export const businessModels = () =>
  mongoose
    .modelNames()
    .map(name => mongoose.model(name))
    .filter(model => model.schema.path('business'));

export const labelOf = model => LABELS[model.modelName] || model.modelName;

/** How many records of each kind a business holds — what a reset would delete. */
export const countBusinessData = async business => {
  const counts = {};
  for (const model of businessModels()) {
    counts[labelOf(model)] = await model.countDocuments({ business });
  }
  return counts;
};

const KEEP_SNAPSHOTS = 10;

export const snapshotDir = () =>
  process.env.RESET_SNAPSHOT_DIR || path.join(process.cwd(), 'ops', 'reset-snapshots');

/**
 * Write every record of a business to one JSON-lines file before it is deleted, so a wrong
 * click can be rebuilt for that business alone without restoring the whole database.
 * Throws on any failure — the reset must not go ahead without its safety copy.
 */
export const snapshotBusiness = async business => {
  const dir = snapshotDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${business._id}-${stamp}.jsonl`);
  const out = fs.createWriteStream(file);
  const write = line =>
    new Promise((resolve, reject) => out.write(line, err => (err ? reject(err) : resolve())));

  await write(`${JSON.stringify({ collection: 'businesses', doc: business.toObject() })}\n`);
  for (const model of businessModels()) {
    for await (const doc of model.find({ business: business._id }).lean().cursor()) {
      await write(`${JSON.stringify({ collection: model.collection.name, doc })}\n`);
    }
  }
  await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));

  // Keep the newest few, so the folder cannot grow without bound.
  const old = (await fs.promises.readdir(dir))
    .filter(f => f.endsWith('.jsonl'))
    .sort()
    .slice(0, -KEEP_SNAPSHOTS);
  await Promise.all(old.map(f => fs.promises.unlink(path.join(dir, f))));
  return file;
};
