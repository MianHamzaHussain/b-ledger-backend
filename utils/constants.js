/** Where an order can originate — the order's `source`, for channel analytics. */
export const SALES_CHANNELS = {
  SHOPIFY: 'shopify',
  FACEBOOK: 'facebook',
  INSTAGRAM: 'instagram',
  TIKTOK: 'tiktok',
  WHATSAPP: 'whatsapp',
  WALK_IN: 'walk-in',
  OTHER: 'other'
};

/** Product line a business sells. */
export const BUSINESS_CATEGORIES = {
  CLOTHING: 'clothing',
  COSMETICS: 'cosmetics',
  OTHER: 'other'
};

/** Order fulfillment lifecycle. Payment is a separate axis (see PAYMENT_STATUS). */
export const ORDER_STATUS = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  DISPATCHED: 'dispatched',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
  RETURNED: 'returned',
  // Set only by the exchange endpoint — the original order whose goods came back
  // and were swapped for a linked replacement order. Not a manual transition.
  EXCHANGED: 'exchanged'
};

/** Allowed fulfillment transitions. Terminal states have no exits. */
export const ORDER_TRANSITIONS = {
  pending: ['confirmed', 'dispatched', 'cancelled'],
  confirmed: ['dispatched', 'cancelled'],
  // A return means the customer refused the parcel, so it can only happen while
  // it is still out for delivery. Once delivered (the customer took it), the
  // only thing left is payment — delivered is terminal on the fulfillment axis.
  dispatched: ['delivered', 'returned'],
  delivered: [],
  cancelled: [],
  returned: []
};

/** Statuses whose stock is held out of inventory (decremented). */
export const STOCK_HELD_STATUSES = ['pending', 'confirmed', 'dispatched', 'delivered'];

/** Payment axis — tracked independently of fulfillment. */
export const PAYMENT_STATUS = {
  UNPAID: 'unpaid',
  PAID: 'paid'
};

export const EXPENSE_CATEGORIES = {
  RETURN_DELIVERY: 'return-delivery',
  OTHER: 'other'
};

// ── Accounting ────────────────────────────────────────────────────────────

/** The five account classes of double-entry bookkeeping. */
export const ACCOUNT_TYPES = {
  ASSET: 'asset',
  LIABILITY: 'liability',
  EQUITY: 'equity',
  INCOME: 'income',
  EXPENSE: 'expense'
};

/**
 * The side an account increases on. Assets and expenses grow with debits;
 * liabilities, equity and income grow with credits. Used to present a party or
 * account balance as a positive number in the right direction.
 */
export const NORMAL_BALANCE = {
  [ACCOUNT_TYPES.ASSET]: 'debit',
  [ACCOUNT_TYPES.EXPENSE]: 'debit',
  [ACCOUNT_TYPES.LIABILITY]: 'credit',
  [ACCOUNT_TYPES.EQUITY]: 'credit',
  [ACCOUNT_TYPES.INCOME]: 'credit'
};

/**
 * Kinds of party (subsidiary ledger). Every running-account contact is a party,
 * so all balances — who we owe and who owes us — live in one place.
 */
export const PARTY_TYPES = {
  SUPPLIER: 'supplier',
  RESELLER: 'reseller',
  EMPLOYEE: 'employee',
  // A courier account: COD it holds, and any advance we've paid it, all tracked
  // as one party so every balance lives in one place.
  COURIER: 'courier',
  // A walk-in / direct-sale buyer we extend credit to. When a counter sale is
  // left unpaid, the balance owed is sub-ledgered here so we know who owes us.
  CUSTOMER: 'customer',
  // A lender (a bank or a person we borrowed from). Loan Payable is sub-ledgered
  // to it, so each loan has its own statement — principal, installments, balance.
  LENDER: 'lender'
};

/** What posted a journal entry — for traceability and idempotency. */
export const JOURNAL_SOURCES = {
  MANUAL: 'manual',
  CAPITAL: 'capital',
  EXPENSE: 'expense',
  PAYMENT: 'payment',
  SALARY: 'salary',
  BATCH: 'batch',
  ORDER: 'order',
  CONSIGNMENT: 'consignment',
  OPENING: 'opening',
  // Capital-side flows with their own guided record types.
  ASSET: 'asset',
  LOAN: 'loan',
  DEPRECIATION: 'depreciation',
  // Year-end close: sweeps income/expense into retained earnings.
  CLOSING: 'closing'
};

/** In-app notification kinds — drive the bell's icon/colour on the client. */
export const NOTIFICATION_TYPES = {
  NEW_ORDER: 'new-order',
  ORDER_PAID: 'order-paid',
  LOW_STOCK: 'low-stock'
};

/** Name of the protected, full-access role created by the seeder. */
export const ADMIN_ROLE_NAME = 'Admin';
