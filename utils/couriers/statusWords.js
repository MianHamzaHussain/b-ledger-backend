/**
 * What the courier's own words mean, as one of a few plain phases the Orders screen can show. PostEx
 * reports a status text ("Out For Delivery") and a numbered journey (code 0004 "Package on Route");
 * the guide (3.8.3) lists the codes, but the portal may say more than the guide does — so anything
 * we do not recognise is `unknown`, and the screen then shows the courier's exact words instead of a guess.
 */
export const PHASES = {
  BOOKED: 'booked',
  AT_WAREHOUSE: 'at-warehouse',
  ON_ROUTE: 'on-route',
  ATTEMPT_FAILED: 'attempt-failed',
  UNDER_REVIEW: 'under-review',
  DELIVERED: 'delivered',
  RETURNED: 'returned',
  CANCELLED: 'cancelled',
  UNKNOWN: 'unknown'
};

/** Phases that mean a person should look at the parcel. Routine steps stay quiet. */
export const NEEDS_ATTENTION = new Set([PHASES.ATTEMPT_FAILED, PHASES.UNDER_REVIEW]);

// Guide 3.8.3 message codes.
const BY_CODE = {
  '0001': PHASES.BOOKED, // At Merchant's Warehouse
  '0002': PHASES.RETURNED, // Returned (also "Booking Cancelled by Merchant" — text decides below)
  '0003': PHASES.AT_WAREHOUSE, // At PostEx Warehouse
  '0004': PHASES.ON_ROUTE, // Package on Route
  '0005': PHASES.DELIVERED,
  '0006': PHASES.RETURNED,
  '0007': PHASES.RETURNED,
  '0008': PHASES.UNDER_REVIEW, // Delivery Under Review
  '0013': PHASES.ATTEMPT_FAILED // Attempt Made: <reason>
};

// The text PostEx puts in `transactionStatus`, and the journey messages, matched by meaning.
const BY_TEXT = [
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

/**
 * The phase of one parcel from its fresh PostEx record `{ status, history: [{ code, message }] }`. The
 * status text is the courier's current word; when it is empty the last journey code decides. "Booking
 * Cancelled by Merchant" arrives under the returned code 0002, so a cancel wording beats the code.
 */
export const phaseOf = ({ status = '', history = [] } = {}) => {
  const text = String(status).trim().toLowerCase();
  const last = history.at(-1);
  const lastText = String(last?.message ?? '').toLowerCase();

  if (/cancel/.test(text) || /cancel/.test(lastText)) return PHASES.CANCELLED;

  if (text) {
    // "Out For Return" is moving back, not yet returned — the courier says Returned when it is.
    if (/out for return/.test(text)) return PHASES.ON_ROUTE;
    for (const [re, phase] of BY_TEXT) if (re.test(text)) return phase;
  }
  if (last?.code && BY_CODE[last.code]) return BY_CODE[last.code];
  return PHASES.UNKNOWN;
};
