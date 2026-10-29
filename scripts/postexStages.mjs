/*
 * READ-ONLY: what stage the app gives each of your real PostEx parcels, from your own machine.
 *
 *   1. POSTEX_API_KEY=... in backend/.env   (gitignored)
 *   2. npm run postex:stages
 *
 * Lists the parcels PostEx has for the key (last 60 days, the list API), then tracks each one and prints, per
 * parcel: tracking number | PostEx's word | newest step (code + words) | the stage the app shows | the
 * attempt reasons. It books nothing, cancels nothing, and never prints the key, a customer's name, phone or
 * address.
 */
import { createPostex } from '../utils/couriers/postex.js';
import { phaseOf } from '../utils/couriers/statusWords.js';
import { attemptReason } from '../utils/courierSync.js';

const token = process.env.POSTEX_API_KEY?.trim();
if (!token) {
  console.error('POSTEX_API_KEY is empty. Add the key to backend/.env first.');
  process.exit(1);
}

const BASE = 'https://api.postex.pk/services/integration/api';
const day = d => d.toISOString().slice(0, 10);
const from = day(new Date(Date.now() - 60 * 86400_000));
const to = day(new Date());

// The guide names these parameters differently; these are the ones the live API accepts.
const res = await fetch(
  `${BASE}/order/v1/get-all-order?orderStatusId=0&startDate=${from}&endDate=${to}`,
  {
    headers: { token }
  }
);
const list = (await res.json().catch(() => ({}))).dist ?? [];
console.log(`PostEx has ${list.length} parcels for this key (${from} to ${to}).`);

const api = createPostex({ token });
for (const row of list) {
  const t = await api.track(row.trackingNumber);
  const newest = t.history.at(-1);
  const attempts = t.history
    .filter(h => h.code === '0013')
    .map(h => attemptReason(h.message.replace(/^attempt made:?\s*/i, '')));
  console.log(
    [
      row.trackingNumber,
      t.status || '(no word)',
      newest ? `${newest.code} ${newest.message}` : '(no steps)',
      `STAGE: ${phaseOf(t)}`,
      attempts.length ? `tries: ${attempts.join(', ')}` : ''
    ]
      .filter(Boolean)
      .join(' | ')
  );
}
