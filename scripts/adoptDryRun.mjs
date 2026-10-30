/*
 * Read-only: which dispatched orders with a hand-typed tracking number would the app take over, and why
 * not for the rest. Writes nothing and never prints a key.
 *
 *   npm run adopt:dryrun
 *
 * Run it on the server (it needs the database and COURIER_SECRET_KEY to open the saved keys).
 */
import mongoose from 'mongoose';
import '../models/Party.js';
import '../models/Order.js';
import { adoptTypedParcels } from '../utils/couriers/adopt.js';

await mongoose.connect(process.env.MONGODB_URI);
let exitCode = 0;
try {
  const { verdicts, adopted, skipped, errors } = await adoptTypedParcels({ dryRun: true });
  for (const v of verdicts) {
    console.log(
      `#${v.order} | ${v.tracking} | ${v.ok ? 'WOULD FOLLOW' : `left alone: ${v.reason}`}`
    );
  }
  console.log(
    `${adopted} would be followed, ${skipped} left alone, ${errors} not checked. Nothing was changed.`
  );
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  await mongoose.disconnect();
}
process.exit(exitCode);
