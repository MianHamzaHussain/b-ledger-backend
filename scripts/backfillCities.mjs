/*
 * Clean the free-text cities on old orders and customers into the standard list
 * ("lhr" → Lahore), so the courier report groups a place once.
 *
 *   npm run backfill:cities             dry run — changes nothing, prints what it would do
 *   npm run backfill:cities -- --apply  writes the changes
 *
 * Take a backup first (sudo bledger-backup). Names it cannot place — a spelling
 * that is not listed or a known alias — are only tidied (Title Case) and are
 * listed at the end for a person to look at; nothing is guessed.
 */
import mongoose from 'mongoose';
import { isListedCity, normalizeCity } from '../utils/cities.js';

const APPLY = process.argv.includes('--apply');

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;

let exitCode = 0;
try {
  for (const name of ['orders', 'customers']) {
    const collection = db.collection(name);
    // One pass over the distinct spellings, then one bulk update per spelling.
    const spellings = await collection
      .aggregate([
        { $match: { city: { $type: 'string', $ne: '' } } },
        { $group: { _id: '$city', count: { $sum: 1 } } }
      ])
      .toArray();

    const changes = spellings
      .map(({ _id: from, count }) => ({ from, to: normalizeCity(from), count }))
      .filter(({ from, to }) => to !== from);
    // Every place the list does not know — including ones already tidy, which are
    // not "changes" but still need a person to decide if they are real towns.
    const unplacedCounts = new Map();
    for (const { _id: from, count } of spellings) {
      const to = normalizeCity(from);
      if (to && !isListedCity(to)) unplacedCounts.set(to, (unplacedCounts.get(to) || 0) + count);
    }
    const unplaced = [...unplacedCounts].map(([to, count]) => ({ to, count }));

    const total = changes.reduce((sum, c) => sum + c.count, 0);
    console.log(`\n${name}: ${total} record(s) in ${changes.length} spelling(s) would change`);
    for (const { from, to, count } of changes)
      console.log(`  ${JSON.stringify(from)} → ${to}  (${count})`);
    if (unplaced.length) {
      console.log(`  Not on the city list — check these by hand:`);
      for (const { to, count } of unplaced) console.log(`    ${to}  (${count})`);
    }

    if (APPLY) {
      for (const { from, to } of changes) {
        const filter = { city: from };
        const result = to
          ? await collection.updateMany(filter, { $set: { city: to } })
          : await collection.updateMany(filter, { $unset: { city: '' } });
        console.log(`  updated ${result.modifiedCount} for ${JSON.stringify(from)}`);
      }
    }
  }
  console.log(APPLY ? '\nDone.' : '\nDry run only. Add --apply to write these changes.');
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  await mongoose.disconnect();
}
process.exit(exitCode);
