import Account from '../models/Account.js';
import Category from '../models/Category.js';
import CourierInvoice from '../models/CourierInvoice.js';
import JournalEntry from '../models/JournalEntry.js';
import Order from '../models/Order.js';
import Party from '../models/Party.js';
import Product from '../models/Product.js';
import ProductionBatch from '../models/ProductionBatch.js';
import { CODES } from './chartOfAccounts.js';
import { JOURNAL_SOURCES, ORDER_STATUS } from './constants.js';

/**
 * The "getting started" checklist for one business — each step is done when
 * the data it asks for exists, so the list ticks itself off as people work.
 * The order is the order to learn the app in: set up, then Khata (money in and
 * out) before stock, then the order flow end to end.
 */

/** Khata entries: a party's own money moves, not the order or courier flows. */
const KHATA_SOURCES = [
  JOURNAL_SOURCES.PAYMENT,
  JOURNAL_SOURCES.EXPENSE,
  JOURNAL_SOURCES.SALARY,
  JOURNAL_SOURCES.LOAN
];

const has = async query => Boolean(await query);

export const gettingStarted = async business => {
  const [
    category,
    moneyAccounts,
    capital,
    khataPeople,
    khataEntry,
    products,
    production,
    order,
    delivered,
    courierInvoice
  ] = await Promise.all([
    has(Category.exists({})),
    // Cash and the main bank come with every business — a step is adding your own.
    has(
      Account.exists({
        business,
        moneyKind: { $exists: true },
        code: { $nin: [CODES.CASH, CODES.BANK] }
      })
    ),
    has(JournalEntry.exists({ business, 'source.kind': JOURNAL_SOURCES.CAPITAL })),
    has(Party.exists({ business })),
    has(
      JournalEntry.exists({
        business,
        'source.kind': { $in: KHATA_SOURCES },
        'lines.party': { $exists: true }
      })
    ),
    has(Product.exists({ business })),
    has(ProductionBatch.exists({ business })),
    has(Order.exists({ business })),
    has(Order.exists({ business, status: ORDER_STATUS.DELIVERED })),
    has(CourierInvoice.exists({ business }))
  ]);

  return {
    category,
    business: true,
    moneyAccounts,
    capital,
    khataPeople,
    khataEntry,
    products,
    production,
    order,
    delivered,
    courierInvoice
  };
};
