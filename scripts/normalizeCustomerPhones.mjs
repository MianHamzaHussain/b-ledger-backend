/*
 * Save every customer's phone in one standard form (03XXXXXXXXX) and merge the customers that
 * were the same person typed differently — needed once, before customers are imported.
 *
 *   npm run normalize:phones             dry run — changes nothing, prints what it would do
 *   npm run normalize:phones -- --apply  writes the changes
 *
 * Take a backup first (sudo bledger-backup). Safe to run twice: the second run finds nothing.
 */
import mongoose from 'mongoose';
import { normalizeCustomerPhones } from '../utils/normalizeCustomerPhones.js';

const APPLY = process.argv.includes('--apply');

await mongoose.connect(process.env.MONGODB_URI);
let exitCode = 0;
try {
  const report = await normalizeCustomerPhones({ apply: APPLY });
  console.log(
    `${APPLY ? 'Done' : 'Dry run'}: ${report.checked} customers checked, ` +
      `${report.rewritten} phones rewritten, ${report.merged} duplicates merged.`
  );
  if (!APPLY && (report.rewritten > 0 || report.merged > 0)) {
    console.log('Nothing was changed. Run again with --apply to write it.');
  }
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  await mongoose.disconnect();
}
process.exit(exitCode);
