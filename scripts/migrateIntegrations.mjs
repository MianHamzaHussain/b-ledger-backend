/*
 * ONE-OFF (Round 11). Rename the stored "couriers" permission to "integrations" in every role and every
 * per-person override. Run it ONCE, on the server, BEFORE the new frontend is merged. Delete it afterwards.
 *
 *   npm run migrate:integrations             dry run — changes nothing, prints what it would do
 *   npm run migrate:integrations -- --apply  writes the change
 *
 * Take a backup first (sudo bledger-backup). Safe to run twice: the second run finds nothing.
 */
import mongoose from 'mongoose';
import { renameCouriersPermission } from '../utils/renameCouriersPermission.js';

const APPLY = process.argv.includes('--apply');

await mongoose.connect(process.env.MONGODB_URI);
let exitCode = 0;
try {
  const { roles, users } = await renameCouriersPermission({ apply: APPLY });
  console.log(
    `${APPLY ? 'Done' : 'Dry run'}: ${roles} role(s) and ${users} person(s) hold the old "couriers" permission.`
  );
  if (!APPLY && (roles > 0 || users > 0))
    console.log('Nothing was changed. Run again with --apply to write it.');
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  await mongoose.disconnect();
}
process.exit(exitCode);
