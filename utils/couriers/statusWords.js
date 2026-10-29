import logger from '../logger.js';

/**
 * What a courier's own words and codes mean, as one of a few plain stages the Orders screen can show.
 *
 * PostEx is read **code first, words second** (verified on real parcels, 2026-10-29): its `track-order` answers
 * with the dashboard's wording ("PostEx WareHouse", "Delivery Under Review") and a journey of coded steps, and the
 * current word can hide where the parcel really is — a refused parcel on its way back says "En-Route to
 * Islamabad warehouse". The journey tells the truth (return steps after the refusal), so it decides.
 *
 * Anything not recognised is `unknown`: the screen then shows the courier's exact words, never a guess, and
 * the word is logged once so a new one gets mapped.
 */
export const PHASES = {
  UNBOOKED: 'unbooked',
  BOOKED: 'booked',
  PICKED_UP: 'picked-up',
  IN_TRANSIT: 'in-transit',
  AT_WAREHOUSE: 'at-warehouse',
  ON_ROUTE: 'on-route',
  ATTEMPT_FAILED: 'attempt-failed',
  UNDER_REVIEW: 'under-review',
  EXPIRED: 'expired',
  RETURNING: 'returning',
  DELIVERED: 'delivered',
  RETURNED: 'returned',
  CANCELLED: 'cancelled',
  UNKNOWN: 'unknown'
};

/** Phases that mean a person should look at the parcel. Routine steps stay quiet. */
export const NEEDS_ATTENTION = new Set([
  PHASES.ATTEMPT_FAILED,
  PHASES.UNDER_REVIEW,
  PHASES.EXPIRED
]);

/** Stages after which nothing more is expected from the courier. */
export const FINAL_PHASES = new Set([PHASES.DELIVERED, PHASES.RETURNED, PHASES.CANCELLED]);

/**
 * The journey, oldest first. When every step carries a time it is sorted by it — one PostEx channel lists
 * newest first — otherwise the courier's own order is kept (the real API lists oldest first).
 */
export const orderedSteps = (history = []) => {
  const steps = Array.isArray(history) ? history : [];
  if (steps.length < 2) return steps;
  const times = steps.map(s => Date.parse(s?.at ?? ''));
  if (!times.every(Number.isFinite)) return steps;
  return steps
    .map((step, i) => ({ step, t: times[i], i }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map(x => x.step);
};

// PostEx message codes seen on real parcels (the guide lists only some of them).
const RETURN_CODES = new Set(['0037', '0039', '0040']); // Return to <city>, Waiting for Return, Return Process Initiated
const DELIVERY_CODES = new Set(['0004', '0005']); // Enroute for Delivery, Delivered
const RETURNED_CODES = new Set(['0006', '0007']);

const BY_CODE = {
  '0031': PHASES.PICKED_UP, // Departed to PostEx. Warehouse
  '0003': PHASES.AT_WAREHOUSE, // Received at <city> Warehouse
  '0038': PHASES.AT_WAREHOUSE, // Waiting for Delivery (at the delivery city's hub)
  '0033': PHASES.IN_TRANSIT, // Departed to <city>
  '0035': PHASES.IN_TRANSIT, // Arrived at Transit Hub <city>
  '0004': PHASES.ON_ROUTE, // Enroute for Delivery
  '0013': PHASES.ATTEMPT_FAILED, // Attempt Made: <reason>
  '0008': PHASES.UNDER_REVIEW // Delivery Under Review
};

// The words, for a parcel whose newest code is not known. Order matters: the first match wins.
const BY_WORD = [
  [/^unbooked$/, PHASES.UNBOOKED],
  [/^booked$/, PHASES.BOOKED],
  [/picked/, PHASES.PICKED_UP],
  [/en-?route to .* warehouse|transferred/, PHASES.IN_TRANSIT],
  [/warehouse|in stock/, PHASES.AT_WAREHOUSE],
  [/out for delivery|enroute for delivery/, PHASES.ON_ROUTE],
  [/attempt/, PHASES.ATTEMPT_FAILED],
  [/under review|under verification/, PHASES.UNDER_REVIEW],
  [/expired/, PHASES.EXPIRED]
];

const warned = new Set();
const unmapped = (provider, word, code) => {
  const key = `${provider}|${word}|${code}`;
  if (warned.has(key)) return;
  warned.add(key);
  logger.info({ provider, word, code }, 'unmapped courier status');
};

const lastIndexWhere = (steps, test) => {
  for (let i = steps.length - 1; i >= 0; i -= 1) if (test(steps[i])) return i;
  return -1;
};

/** PostEx: the stage of one parcel from `{ status, history: [{ code, message, at? }] }`. */
const postexPhase = ({ status = '', history = [] } = {}) => {
  const word = String(status).trim();
  const lower = word.toLowerCase();
  const steps = orderedSteps(history);
  const newest = steps.at(-1);
  const code = newest?.code;
  const newestText = String(newest?.message ?? '').toLowerCase();

  // A cancel wording beats everything: PostEx has filed a cancellation under a "returned" code before.
  if (/cancel|un-?assigned by me/.test(lower) || /cancel/.test(newestText) || code === '0002') {
    return PHASES.CANCELLED;
  }
  if (lower === 'delivered' || code === '0005') return PHASES.DELIVERED;
  if (lower === 'returned' || RETURNED_CODES.has(code)) return PHASES.RETURNED;

  // On its way back: PostEx says so, or the journey has a return step after the last delivery step.
  const lastReturn = lastIndexWhere(steps, s => RETURN_CODES.has(s?.code));
  const lastDelivery = lastIndexWhere(steps, s => DELIVERY_CODES.has(s?.code));
  if (/out for return/.test(lower) || (lastReturn >= 0 && lastReturn > lastDelivery)) {
    return PHASES.RETURNING;
  }

  if (code === '0001') return /^unbooked$/.test(lower) ? PHASES.UNBOOKED : PHASES.BOOKED;
  if (BY_CODE[code]) return BY_CODE[code];
  for (const [re, phase] of BY_WORD) if (re.test(lower)) return phase;

  if (word || code) unmapped('postex', word, code ?? '');
  return PHASES.UNKNOWN;
};

// ── TCS (and anything else) keeps the word rules it had: its code table is not known yet ───────────────────
const LEGACY_BY_CODE = {
  '0001': PHASES.BOOKED,
  '0003': PHASES.AT_WAREHOUSE,
  '0004': PHASES.ON_ROUTE,
  '0005': PHASES.DELIVERED,
  '0006': PHASES.RETURNED,
  '0007': PHASES.RETURNED,
  '0008': PHASES.UNDER_REVIEW,
  '0013': PHASES.ATTEMPT_FAILED
};
const LEGACY_BY_TEXT = [
  [/cancel/, PHASES.CANCELLED],
  [/^delivered$/, PHASES.DELIVERED],
  [/out for return|return/, PHASES.RETURNED],
  [/under review/, PHASES.UNDER_REVIEW],
  [/attempt/, PHASES.ATTEMPT_FAILED],
  [/out for delivery|on route|on root|dispatch/, PHASES.ON_ROUTE],
  // TCS words its journey "Arrived at TCS Facility" / "Shipment Picked Up".
  [/warehouse|picked by|picked up|received|facility|arrived/, PHASES.AT_WAREHOUSE],
  [/^booked|unbooked|pending|merchant/, PHASES.BOOKED]
];
const legacyPhase = ({ status = '', history = [] } = {}) => {
  const text = String(status).trim().toLowerCase();
  const last = history.at(-1);
  if (/cancel/.test(text) || /cancel/.test(String(last?.message ?? '').toLowerCase())) {
    return PHASES.CANCELLED;
  }
  if (text) {
    if (/out for return/.test(text)) return PHASES.ON_ROUTE;
    for (const [re, phase] of LEGACY_BY_TEXT) if (re.test(text)) return phase;
  }
  if (last?.code && LEGACY_BY_CODE[last.code]) return LEGACY_BY_CODE[last.code];
  return PHASES.UNKNOWN;
};

/**
 * The stage of one parcel from its fresh record `{ status, history: [{ code, message, at? }] }`.
 * `provider` picks the table; only PostEx has a verified code table so far.
 */
export const phaseOf = (fresh, provider = 'postex') =>
  provider === 'postex' ? postexPhase(fresh) : legacyPhase(fresh);
