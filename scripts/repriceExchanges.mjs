/*
 * ONE-OFF (2026-11-26). Re-work the exchanges made under the OLD rule (both parcels charged) that have NOT been
 * dispatched yet, so they charge only the new parcel's courier cost. Dispatched ones and swaps are left alone.
 * Delete this script once it has been run.
 *
 *   npm run reprice:exchanges             dry run — changes nothing, lists each order's COD before → after
 *   npm run reprice:exchanges -- --apply  writes the change
 *
 * Take a backup first (sudo bledger-backup). Safe to run twice: the second run finds nothing.
 */
import mongoose from 'mongoose';
import { repriceExchanges } from '../utils/repriceExchanges.js';

const APPLY = process.argv.includes('--apply');

await mongoose.connect(process.env.MONGODB_URI);
let exitCode = 0;
try {
  const { changes } = await repriceExchanges({ apply: APPLY });
  for (const c of changes) {
    console.log(
      `#${c.orderNumber} (exchange of #${c.originalNumber}, business ${c.business}): COD Rs ${c.codBefore} → Rs ${c.codAfter}` +
        (APPLY ? `  (saved: Rs ${c.codSaved})` : '')
    );
  }
  console.log(
    `${APPLY ? 'Done' : 'Dry run'}: ${changes.length} replacement(s) not yet dispatched were made under the old rule.`
  );
  if (!APPLY && changes.length > 0)
    console.log('Nothing was changed. Run again with --apply to write it.');
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  await mongoose.disconnect();
}
process.exit(exitCode);
