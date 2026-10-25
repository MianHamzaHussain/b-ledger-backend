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
  'city',
  'trackingId',
  'customerNote',
  'shopifyOrderNumber',
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
  'awaitingReturn'
].join(' ');
