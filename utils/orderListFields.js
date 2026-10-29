/**
 * What an Orders list row carries. Lean on purpose: the row names who it is for, the numbers,
 * status and money — and, in one short line, WHAT was ordered (article, size, quantity), because
 * staff kept opening orders just to see that. The item sub-fields are the sold-time snapshot
 * (`productName`, `variantLabel`), so no lookup is needed and a later rename changes nothing.
 *
 * No price or cost field is listed here: the full item table, with money, stays on the
 * detail-by-id endpoint (and its cost is for people who may "See costs").
 */
export const ORDER_LIST_FIELDS = [
  'orderNumber',
  'dailySerial',
  'orderDay',
  'customerName',
  'contactNumber',
  'city',
  'trackingId',
  'customerNote',
  'shopifyOrderNumber',
  'selfDelivery',
  'deliveredBy',
  'status',
  'bookedFor',
  'paymentStatus',
  'total',
  'itemCount',
  'items.productName',
  'items.variantLabel',
  'items.quantity',
  'customWork.description',
  'createdAt',
  'dispatchedAt',
  'deliveredAt',
  'refundDuePaisa',
  'advanceAmount',
  'codAmount',
  'reversalTrackingId',
  'awaitingReturn',
  'returnedPieces',
  // What the list shows about a courier-booked parcel — never its history or the raw key fields.
  'awaitingCity.city',
  'awaitingCity.openedAt',
  'courierBooking.provider',
  'courierBooking.courierStatus',
  'courierBooking.billPrinted',
  'courierBooking.phase',
  'courierBooking.needsAttention',
  // Each reason only (not the notes) — the row says "Attempt 2 — customer not available".
  'deliveryAttempts.reason',
  'courierBooking.confirmable',
  'courierBooking.fee',
  'courierBooking.tax'
].join(' ');
