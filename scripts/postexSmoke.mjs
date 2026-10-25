/*
 * A read-only check of a PostEx key from your own machine — before the app is involved.
 *
 *   1. Put the key in backend/.env as  POSTEX_API_KEY=...   (this file is gitignored)
 *   2. npm run postex:check
 *
 * It asks PostEx for the cities it delivers to and your pickup addresses, and prints a summary. It
 * does NOT book a parcel, and it never prints the key. The app itself keeps the key encrypted in the
 * database (Parties → the courier → Connect PostEx); this script is only for trying the key locally.
 */
import { createPostex } from '../utils/couriers/postex.js';

const token = process.env.POSTEX_API_KEY?.trim();
if (!token) {
  console.error('POSTEX_API_KEY is empty. Add the key to backend/.env first.');
  process.exit(1);
}

const api = createPostex({ token });
try {
  const cities = await api.cities('delivery');
  console.log(
    `OK — PostEx accepted the key. It delivers to ${cities.length} cities (e.g. ${cities.slice(0, 5).join(', ')}).`
  );
  const addresses = await api.addresses();
  console.log(`Pickup addresses on the account: ${addresses.length}`);
  for (const a of addresses) console.log(`  code ${a.addressCode} — ${a.cityName} — ${a.address}`);
} catch (err) {
  console.error(`Failed: ${err.message}`);
  process.exitCode = 1;
}
