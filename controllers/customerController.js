import Customer from '../models/Customer.js';
import Business from '../models/Business.js';
import asyncHandler from '../middlewares/asyncHandler.js';
import ErrorResponse from '../utils/errorResponse.js';
import logger from '../utils/logger.js';
import { createCrudHandlers } from '../utils/crudController.js';
import { normalizePhone, phoneProblem, toWhatsApp } from '../utils/phone.js';
import { CSV_BOM, csvRow } from '../utils/csv.js';
import { pakistanDay } from '../utils/pakistanDay.js';
import Order from '../models/Order.js';
import { customerStats, NO_ORDERS } from '../utils/customerStats.js';
import { escapeRegex } from '../utils/escapeRegex.js';

/**
 * Customers — they appear when an order is placed (upserted by phone), and can also be added by
 * hand or imported from an old list (contacts with no order behind them). Scoped to the business
 * like every transactional record; the list can be exported for WhatsApp.
 *
 * @route  GET  /api/v1/customers              (customers:read — scoped)
 * @route  GET  /api/v1/customers/export       (customers:read — scoped; one business)
 * @route  POST /api/v1/customers              (customers:create — business in scope)
 * @route  POST /api/v1/customers/import       (customers:create — business in scope)
 * @route  GET  /api/v1/customers/:id          (customers:read — scoped)
 * @route  PUT  /api/v1/customers/:id          (customers:update — scoped)
 */
const handlers = createCrudHandlers({ model: Customer });

export const { getAll: getCustomers, getOne: getCustomer, update: updateCustomer } = handlers;

/**
 * @desc   Add a customer by hand. The phone is saved in one standard form, so the same person
 *         typed differently is the same customer — and is told so instead of duplicated.
 */
export const createCustomer = asyncHandler(async (req, res, next) => {
  const { business, name, city, note } = req.body;
  const phone = normalizePhone(req.body.phone);
  const problem = phoneProblem(phone);
  if (problem) return next(new ErrorResponse(problem, 400));

  const existing = await Customer.findOne({ business, phone }, 'name');
  if (existing) {
    return res.status(400).json({
      success: false,
      error: `A customer with this number already exists: ${existing.name}`,
      existing: { _id: existing._id, name: existing.name }
    });
  }

  const customer = await Customer.create({
    business,
    name,
    phone,
    city,
    note,
    source: 'manual',
    createdBy: req.user.id
  });
  res.status(201).json({ success: true, data: customer });
});

/**
 * @desc   Import a list of contacts (up to 500 rows per request — the client sends bigger files
 *         in chunks). New phones are added; a phone that is already a customer is SKIPPED, never
 *         overwritten. Safe to send twice: the second time adds nothing.
 */
export const importCustomers = asyncHandler(async (req, res) => {
  const { business, rows } = req.body;

  const invalid = [];
  const seen = new Set();
  const fresh = [];
  rows.forEach((row, index) => {
    const line = row.line ?? index + 1;
    const phone = normalizePhone(row.phone);
    const problem = !row.name ? 'The name is missing' : phoneProblem(phone);
    if (problem) return invalid.push({ row: line, reason: problem });
    if (seen.has(phone)) return; // the same number twice in the file
    seen.add(phone);
    fresh.push({ name: row.name, phone, city: row.city, note: row.note });
  });

  let added = 0;
  if (fresh.length > 0) {
    const result = await Customer.bulkWrite(
      fresh.map(r => ({
        updateOne: {
          filter: { business, phone: r.phone },
          update: {
            $setOnInsert: {
              business,
              name: r.name,
              phone: r.phone,
              ...(r.city && { city: r.city }),
              ...(r.note && { note: r.note }),
              source: 'import',
              createdBy: req.user.id
            }
          },
          upsert: true
        }
      })),
      { ordered: false }
    );
    added = result.upsertedCount;
  }

  logger.info(
    { userId: req.user.id, business, added, invalid: invalid.length },
    'customers imported'
  );
  res.status(200).json({
    success: true,
    data: { added, skipped: fresh.length - added, invalid }
  });
});

/**
 * @desc   The customers of ONE business as a CSV — for WhatsApp and other marketing tools. It is
 *         the whole contact list leaving the app, so each export is logged (and rate-limited by
 *         the route).
 */
export const exportCustomers = asyncHandler(async (req, res, next) => {
  const { business, search } = req.query;
  if (!business) return next(new ErrorResponse('Select a business', 400));
  const allowed = req.accessFilter?.business?.$in;
  if (allowed && !allowed.map(String).includes(String(business))) {
    return next(new ErrorResponse('Business not found', 404));
  }
  const biz = await Business.findById(business, 'name').lean();
  if (!biz) return next(new ErrorResponse('Business not found', 404));

  const filter = { business };
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ name: rx }, { phone: rx }];
  }

  const filename = `${biz.name.replace(/[^\w-]+/g, '-').toLowerCase()}-customers-${pakistanDay()}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.write(`${CSV_BOM}${csvRow(['name', 'phone', 'whatsapp', 'city', 'source', 'addedOn'])}\r\n`);

  let count = 0;
  for await (const c of Customer.find(filter).sort({ name: 1 }).lean().cursor()) {
    res.write(
      `${csvRow([c.name, c.phone, toWhatsApp(c.phone), c.city, c.source ?? 'order', pakistanDay(c.createdAt)])}\r\n`
    );
    count += 1;
  }
  logger.info({ userId: req.user.id, business, rows: count }, 'customers exported');
  res.end();
});

/** The digits of what was typed, in the stored form (03XXXXXXXXX): "+92 302", "302" and "0302" all search the same. */
const phoneSearch = text => {
  const digits = String(text).replace(/\D/g, '');
  if (digits.startsWith('92')) return `0${digits.slice(2)}`;
  if (digits.startsWith('3')) return `0${digits}`;
  return digits;
};

/** One business, from the query — in scope, or a 404 (outside your scope is indistinguishable from none). */
const businessInScope = (req, next) => {
  const { business } = req.query;
  if (!business) {
    next(new ErrorResponse('Select a business', 400));
    return null;
  }
  const allowed = req.accessFilter?.business?.$in;
  if (allowed && !allowed.map(String).includes(String(business))) {
    next(new ErrorResponse('Business not found', 404));
    return null;
  }
  return business;
};

/**
 * @desc   Type-ahead for the order form: customers whose name or number matches, five at a time, each
 *         with how many orders they have had — so the form can say "New" or "Repeat — 4 orders · 1
 *         returned" and fill in the name, number, city and last address. Names and counts only: no money.
 * @route  GET /api/v1/customers/suggest?business=&q=&page=&limit=  (orders:create — scoped)
 */
export const suggestCustomers = asyncHandler(async (req, res, next) => {
  const business = businessInScope(req, next);
  if (!business) return;

  const text = String(req.query.q ?? '').trim();
  const limit = Math.min(Math.max(Number(req.query.limit) || 5, 1), 20);
  const page = Math.max(Number(req.query.page) || 1, 1);
  // Nothing is listed until the person has typed enough to mean something.
  if (text.length < 3) {
    return res.status(200).json({ success: true, count: 0, total: 0, pagination: {}, data: [] });
  }

  const digits = phoneSearch(text);
  const or = [{ name: new RegExp(escapeRegex(text), 'i') }];
  if (digits.length >= 3) or.push({ phone: new RegExp(`^${escapeRegex(digits)}`) });
  const filter = { business, $or: or };

  const [total, rows] = await Promise.all([
    Customer.countDocuments(filter),
    Customer.find(filter)
      .select('name phone city isBlocked blockedReason')
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean()
  ]);

  const stats = await customerStats(
    business,
    rows.map(r => r._id)
  );
  const data = rows.map(r => {
    const { lastAddress, ...counts } = stats.get(String(r._id)) ?? NO_ORDERS;
    return {
      _id: r._id,
      name: r.name,
      phone: r.phone,
      city: r.city,
      lastAddress,
      isBlocked: Boolean(r.isBlocked),
      blockedReason: r.blockedReason,
      orders: counts.orders,
      delivered: counts.delivered,
      returned: counts.returned
    };
  });

  const more = page * limit < total;
  res.status(200).json({
    success: true,
    count: data.length,
    total,
    pagination: more ? { next: { page: page + 1, limit } } : {},
    data
  });
});

/** The columns a customer's order rows carry: who/what/when, status and the courier's word — lean. */
const HISTORY_ROW_FIELDS = [
  'orderNumber',
  'dailySerial',
  'orderDay',
  'status',
  'total',
  'itemCount',
  'trackingId',
  'paymentStatus',
  'createdAt',
  'dispatchedAt',
  'deliveredAt',
  'courierBooking.phase',
  'courierBooking.courierStatus'
].join(' ');

/**
 * @desc   A customer's history: the counts (orders, delivered, returned, cancelled, refused tries, first
 *         and last order, bought) and their orders newest first, a page at a time. Each row opens the
 *         normal order page.
 * @route  GET /api/v1/customers/:id/history?page=&limit=  (customers:read — scoped)
 */
export const getCustomerHistory = asyncHandler(async (req, res) => {
  const customer = req.resource;
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
  const page = Math.max(Number(req.query.page) || 1, 1);

  const [stats, orders] = await Promise.all([
    customerStats(customer.business, [customer._id]),
    Order.find({ business: customer.business, customer: customer._id })
      .select(HISTORY_ROW_FIELDS)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean()
  ]);

  const counts = { ...(stats.get(String(customer._id)) ?? NO_ORDERS) };
  delete counts.lastAddress;
  res.status(200).json({
    success: true,
    count: orders.length,
    total: counts.orders,
    pagination: page * limit < counts.orders ? { next: { page: page + 1, limit } } : {},
    data: {
      customer: {
        _id: customer._id,
        name: customer.name,
        phone: customer.phone,
        city: customer.city,
        note: customer.note,
        createdAt: customer.createdAt,
        isBlocked: Boolean(customer.isBlocked),
        blockedReason: customer.blockedReason,
        blockedAt: customer.blockedAt
      },
      stats: counts,
      orders
    }
  });
});

/**
 * @desc   Block or unblock a customer. A person does this, with the reason; the system never blocks by
 *         itself. `blockedBy` is the signed-in user, never the body.
 * @route  PUT /api/v1/customers/:id/block  (customers:update — scoped)
 */
export const setCustomerBlocked = asyncHandler(async (req, res) => {
  const customer = req.resource;
  const { isBlocked, reason } = req.body;

  customer.isBlocked = isBlocked ? true : undefined;
  customer.blockedReason = isBlocked ? reason : undefined;
  customer.blockedAt = isBlocked ? new Date() : undefined;
  customer.blockedBy = isBlocked ? req.user.id : undefined;
  customer.updatedBy = req.user.id;
  await customer.save();

  logger.info(
    { userId: req.user.id, customer: String(customer._id), isBlocked: Boolean(isBlocked) },
    'customer block changed'
  );
  res.status(200).json({ success: true, data: customer });
});
