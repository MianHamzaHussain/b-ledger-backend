/*
 * ONE-OFF (Round 15). Give every business that still has only the old single `category` a `categories` list
 * holding it. Run it ONCE, on the server, AFTER the new backend is deployed and BEFORE the new frontend is merged.
 * Delete it in the contract round.
 *
 *   npm run migrate:categories             dry run — changes nothing, prints what it would do
 *   npm run migrate:categories -- --apply  writes the change
 *
 * Take a backup first (sudo bledger-backup). Safe to run twice: the second run finds nothing.
 */
import mongoose from 'mongoose';
import { backfillBusinessCategories } from '../utils/backfillBusinessCategories.js';

const APPLY = process.argv.includes('--apply');

await mongoose.connect(process.env.MONGODB_URI);
let exitCode = 0;
try {
  const { businesses } = await backfillBusinessCategories({ apply: APPLY });
  console.log(
    `${APPLY ? 'Done' : 'Dry run'}: ${businesses} business(es) have only the old single category.`
  );
  if (!APPLY && businesses > 0)
    console.log('Nothing was changed. Run again with --apply to write it.');
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  await mongoose.disconnect();
}
process.exit(exitCode);
