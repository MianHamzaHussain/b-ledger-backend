import Customer from '../models/Customer.js';
import Business from '../models/Business.js';
import asyncHandler from '../middlewares/asyncHandler.js';
import ErrorResponse from '../utils/errorResponse.js';
import logger from '../utils/logger.js';
import { createCrudHandlers } from '../utils/crudController.js';
import { normalizePhone, phoneProblem, toWhatsApp } from '../utils/phone.js';
import { CSV_BOM, csvRow } from '../utils/csv.js';
import { pakistanDay } from '../utils/pakistanDay.js';

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
    const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
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
