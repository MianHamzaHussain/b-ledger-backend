/*
 * ONE-OFF (Round 16). List every earlier asset purchase (an entry with no asset behind it) in the new asset list, so it
 * can be sold or thrown away. Run it ONCE on the server after the new backend is deployed. Delete it afterwards.
 *
 *   npm run assets:import             dry run — changes nothing, prints what it would list per business
 *   npm run assets:import -- --apply  writes the list
 *
 * Take a backup first (sudo bledger-backup). Safe to run twice: the second run finds nothing.
 * If you are also clearing a business's hand-entered money, clear FIRST and run this after.
 */
import mongoose from 'mongoose';
import { importFixedAssets } from '../utils/importFixedAssets.js';

const APPLY = process.argv.includes('--apply');

await mongoose.connect(process.env.MONGODB_URI);
let exitCode = 0;
try {
  const { businesses, assets } = await importFixedAssets({ apply: APPLY });
  for (const b of businesses) {
    console.log(
      `business ${b.business}: ${b.count} asset(s), cost Rs ${b.costPaisa / 100}; depreciation posted so far Rs ${b.depreciationPaisa / 100}`
    );
  }
  console.log(
    `${APPLY ? 'Done' : 'Dry run'}: ${assets} earlier purchase(s) not yet in the asset list.`
  );
  if (!APPLY && assets > 0) console.log('Nothing was changed. Run again with --apply to write it.');
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  await mongoose.disconnect();
}
process.exit(exitCode);
