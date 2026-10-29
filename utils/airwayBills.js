import { PDFDocument } from 'pdf-lib';
import Order from '../models/Order.js';
import ErrorResponse from './errorResponse.js';
import { adapterFor } from './couriers/index.js';

/**
 * Many airway bills as ONE printable PDF. PostEx hands out at most 10 bills per call and one PDF per call,
 * so the parcels are asked for 10 at a time (a few calls in parallel), a call the courier rejects is
 * retried one parcel at a time — one bad parcel never blocks the rest — and the answers are stitched
 * together in the order the person ticked them. Parcels that could not be fetched are returned by name
 * so the screen can say which.
 */
const PER_CALL = 10;
const IN_PARALLEL = 3;

/** Run `fn` over `items`, at most `limit` at once, keeping results in order. */
const mapLimit = async (items, limit, fn) => {
  const results = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

/** Stitch PDFs together, keeping each one's pages and sizes as the courier made them. */
export const mergePdfs = async buffers => {
  const out = await PDFDocument.create();
  for (const buffer of buffers) {
    const source = await PDFDocument.load(buffer);
    const pages = await out.copyPages(source, source.getPageIndices());
    pages.forEach(page => out.addPage(page));
  }
  return Buffer.from(await out.save());
};

/**
 * `orderIds` are in the order the person ticked them. Only parcels booked through a connected courier's
 * service (a tracking number from it) can have a bill; the rest are named in `skipped`.
 * Returns `{ pdf, printed: [orderId], skipped: [{ orderNumber, reason }] }`.
 */
export const airwayBillsFor = async ({ business, orderIds }) => {
  const found = await Order.find({ _id: { $in: orderIds }, business }).select(
    'orderNumber courier courierBooking.trackingNumber'
  );
  const byId = new Map(found.map(o => [String(o._id), o]));
  const skipped = [];
  const wanted = [];
  for (const id of orderIds) {
    const order = byId.get(String(id));
    if (!order) continue; // not this business's — never named, never fetched
    if (!order.courier || !order.courierBooking?.trackingNumber) {
      skipped.push({
        orderNumber: order.orderNumber,
        reason: 'Not booked through a courier service'
      });
      continue;
    }
    wanted.push(order);
  }
  if (!wanted.length) {
    throw new ErrorResponse('None of these orders was booked through a courier service', 400);
  }

  // Each courier has its own saved key; its parcels go in 10s, in the order they were ticked.
  const byCourier = new Map();
  for (const order of wanted) {
    const key = String(order.courier);
    if (!byCourier.has(key)) byCourier.set(key, []);
    byCourier.get(key).push(order);
  }

  const calls = [];
  for (const [courier, orders] of byCourier) {
    for (let i = 0; i < orders.length; i += PER_CALL) {
      calls.push({ courier, orders: orders.slice(i, i + PER_CALL) });
    }
  }

  const apis = new Map();
  const apiFor = async courier => {
    if (!apis.has(courier))
      apis.set(courier, (await adapterFor(courier, { requireEnabled: false })).api);
    return apis.get(courier);
  };

  const parts = await mapLimit(calls, IN_PARALLEL, async ({ courier, orders }) => {
    const numbers = orders.map(o => o.courierBooking.trackingNumber);
    try {
      const api = await apiFor(courier);
      return [{ pdf: await api.airwayBill(numbers), orders }];
    } catch {
      // The whole call failed: ask for each parcel alone, so one bad parcel does not hide the others.
      const singles = [];
      for (const order of orders) {
        try {
          const api = await apiFor(courier);
          singles.push({
            pdf: await api.airwayBill([order.courierBooking.trackingNumber]),
            orders: [order]
          });
        } catch (err) {
          skipped.push({
            orderNumber: order.orderNumber,
            reason: err.message || 'The courier refused it'
          });
        }
      }
      return singles;
    }
  });

  const good = parts.flat();
  if (!good.length) {
    throw new ErrorResponse(
      `The courier gave no bills: ${skipped.map(s => `#${s.orderNumber} (${s.reason})`).join(', ')}`,
      502
    );
  }
  return {
    pdf: await mergePdfs(good.map(g => g.pdf)),
    printed: good.flatMap(g => g.orders.map(o => o._id)),
    skipped
  };
};
