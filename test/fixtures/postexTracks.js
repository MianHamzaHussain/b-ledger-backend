/**
 * Real PostEx `track-order` answers (anonymised: fake tracking numbers, "<SHOP>" for the merchant), captured
 * 2026-10-29 from a live account. The real API lists steps OLDEST FIRST with `updatedAt`; one other PostEx
 * channel lists them newest first with `modifiedDatetime` (see NEWEST_FIRST).
 */
const step = (code, message, updatedAt) => ({
  transactionStatusMessageCode: code,
  transactionStatusMessage: message,
  updatedAt
});

/** Refused at the door, then sent back: the current word hides it, the journey shows it. */
export const REFUSED_AND_RETURNING = {
  trackingNumber: 'TEST0001',
  transactionStatus: 'En-Route to Islamabad warehouse',
  transactionFee: 0,
  transactionTax: 0,
  transactionStatusHistory: [
    step('0001', 'At <SHOP> Warehouse', '2026-10-26T19:05:28.000+0500'),
    step('0031', 'Departed to PostEx. Warehouse', '2026-10-26T21:06:46.000+0500'),
    step('0003', 'Received at FSD Warehouse', '2026-10-26T22:58:57.000+0500'),
    step('0033', 'Departed to RAWALPINDI', '2026-10-27T11:52:09.000+0500'),
    step('0035', 'Arrived at Transit Hub RWP', '2026-10-27T23:39:59.000+0500'),
    step('0038', 'Waiting for Delivery', '2026-10-28T00:20:06.000+0500'),
    step('0033', 'Departed to ISLAMABAD', '2026-10-28T04:39:57.000+0500'),
    step('0035', 'Arrived at Transit Hub RWP', '2026-10-28T09:29:15.000+0500'),
    step('0038', 'Waiting for Delivery', '2026-10-28T09:31:10.000+0500'),
    step('0004', 'Enroute for Delivery', '2026-10-28T11:11:55.000+0500'),
    step('0013', 'Attempt Made: RFD(REFUSED TO RECEIVE)', '2026-10-28T14:26:55.000+0500'),
    step('0039', 'Waiting for Return', '2026-10-28T18:42:21.000+0500'),
    step('0040', 'Return Process Initiated', '2026-10-28T18:42:21.000+0500'),
    step('0037', 'Return to ISLAMABAD', '2026-10-29T03:46:58.000+0500'),
    step('0035', 'Arrived at Transit Hub RWP', '2026-10-29T09:29:15.000+0500'),
    step('0037', 'Return to FAISALABAD', '2026-10-29T09:52:20.000+0500'),
    step('0035', 'Arrived at Transit Hub FSD', '2026-10-29T14:57:55.000+0500')
  ]
};

export const DELIVERED = {
  trackingNumber: 'TEST0002',
  transactionStatus: 'Delivered',
  transactionFee: 231.25,
  transactionTax: 37,
  transactionStatusHistory: [
    step('0001', 'At <SHOP> Warehouse', '2026-10-27T16:55:00.000+0500'),
    step('0031', 'Departed to PostEx. Warehouse', '2026-10-27T18:00:00.000+0500'),
    step('0003', 'Received at FSD Warehouse', '2026-10-27T19:00:00.000+0500'),
    step('0033', 'Departed to KARACHI', '2026-10-27T20:00:00.000+0500'),
    step('0035', 'Arrived at Transit Hub KHI', '2026-10-28T21:00:00.000+0500'),
    step('0038', 'Waiting for Delivery', '2026-10-29T08:00:00.000+0500'),
    step('0004', 'Enroute for Delivery', '2026-10-29T10:00:00.000+0500'),
    step('0005', 'Delivered to Customer', '2026-10-29T13:20:00.000+0500')
  ]
};

export const WAITING_FOR_DELIVERY = {
  trackingNumber: 'TEST0003',
  transactionStatus: 'PostEx WareHouse',
  transactionStatusHistory: [
    step('0001', 'At <SHOP> Warehouse', '2026-10-26T19:02:00.000+0500'),
    step('0031', 'Departed to PostEx. Warehouse', '2026-10-26T21:00:00.000+0500'),
    step('0003', 'Received at FSD Warehouse', '2026-10-26T22:00:00.000+0500'),
    step('0038', 'Waiting for Delivery', '2026-10-29T04:27:00.000+0500')
  ]
};

export const PICKED = {
  trackingNumber: 'TEST0004',
  transactionStatus: 'Picked By PostEx',
  transactionStatusHistory: [
    step('0001', 'At <SHOP> Warehouse', '2026-10-29T18:33:00.000+0500'),
    step('0031', 'Departed to PostEx. Warehouse', '2026-10-29T20:10:00.000+0500')
  ]
};

export const UNDER_REVIEW = {
  trackingNumber: 'TEST0005',
  transactionStatus: 'Delivery Under Review',
  transactionStatusHistory: [
    step('0001', 'At <SHOP> Warehouse', '2026-10-26T18:57:00.000+0500'),
    step('0004', 'Enroute for Delivery', '2026-10-28T11:00:00.000+0500'),
    step('0008', 'Delivery Under Review', '2026-10-29T18:31:00.000+0500')
  ]
};

export const CANCELLED = {
  trackingNumber: 'TEST0006',
  transactionStatus: 'Un-Assigned By Me',
  transactionStatusHistory: [
    step('0001', 'At <SHOP> Warehouse', '2026-10-25T14:10:00.000+0500'),
    step('0002', 'Booking Cancelled by Merchant ', '2026-10-25T14:10:30.000+0500')
  ]
};

export const UNBOOKED = {
  trackingNumber: 'TEST0007',
  transactionStatus: 'Unbooked',
  transactionStatusHistory: [step('0001', 'At <SHOP> Warehouse', '2026-10-26T17:03:00.000+0500')]
};

export const ATTEMPT_CNA = {
  trackingNumber: 'TEST0008',
  transactionStatus: 'Attempted',
  transactionStatusHistory: [
    step('0001', 'At <SHOP> Warehouse', '2026-10-27T09:00:00.000+0500'),
    step('0004', 'Enroute for Delivery', '2026-10-28T10:00:00.000+0500'),
    step('0013', 'Attempt Made: CNA(CNA)', '2026-10-28T14:00:00.000+0500')
  ]
};

/** The same journey as REFUSED_AND_RETURNING, the way the other channel sends it: newest first, `modifiedDatetime`, no word. */
export const NEWEST_FIRST = {
  trackingNumber: 'TEST0009',
  transactionStatusHistory: [...REFUSED_AND_RETURNING.transactionStatusHistory]
    .reverse()
    .map(({ updatedAt, ...rest }) => ({ ...rest, modifiedDatetime: updatedAt }))
};
