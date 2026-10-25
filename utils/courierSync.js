import Order from '../models/Order.js';
import { notify } from './notify.js';
import { adapterFor } from './couriers/index.js';
import { NOTIFICATION_TYPES, ORDER_STATUS } from './constants.js';
import logger from './logger.js';

/**
 * Keep dispatched parcels in step with the courier. PostEx has no webhook, so this ASKS: every few
 * minutes it reads the status of each parcel booked through the courier's service.
 *
 * What it does is deliberately small and safe:
 *  - it records where the parcel is and its journey (nothing money-related);
 *  - it logs a failed delivery try, with the courier's reason, so the courier report can count it;
 *  - when the courier says DELIVERED or RETURNED it does NOT change the order — it marks the order
 *    "ready to confirm" and tells people. A person confirms (one tap, a whole batch), through the
 *    normal status path, because those two steps post sales, cost and stock.
 * If the courier later takes it back ("delivered" → "attempted"), the mark is removed again.
 */
// 15 minutes; COURIER_SYNC_SECONDS shortens it for demos (never below 10 s).
const EVERY_MS = Math.max(Number(process.env.COURIER_SYNC_SECONDS) || 15 * 60, 10) * 1000;
const BATCH = 20;
const PER_RUN = 300;

const status = { lastRunAt: null, lastChecked: 0, lastUpdated: 0, lastReady: 0, lastErrors: 0 };
export const courierSyncStatus = () => ({ ...status });

// Message codes from the PostEx guide, 3.8.3.
const DELIVERED_CODES = new Set(['0005']);
const RETURNED_CODES = new Set(['0002', '0006', '0007']);
const ATTEMPT_CODE = '0013';

/** What the courier's words mean for us: delivered, returned, a failed try, or just moving. */
export const readStatus = ({ status: text = '', history = [] }) => {
  const s = text.trim().toLowerCase();
  const last = history.at(-1)?.code;
  if (s === 'delivered' || (!s && DELIVERED_CODES.has(last))) return 'delivered';
  if (s === 'returned' || (!s && RETURNED_CODES.has(last))) return 'returned';
  if (s === 'attempted' || (!s && last === ATTEMPT_CODE)) return 'attempted';
  return 'moving';
};

/** "Attempt Made: Customer not available" → our reason list, with the courier's words kept as the note. */
export const attemptReason = message => {
  const m = message.toLowerCase();
  if (/refus|not interested|cancel/.test(m)) return 'refused';
  if (/wrong|incomplete|incorrect|address|location/.test(m)) return 'wrong-address';
  if (/unreach|not respond|no answer|switched off|phone|contact/.test(m)) return 'unreachable';
  if (/not available|not at home|closed|nobody|absent/.test(m)) return 'not-available';
  return 'other';
};

const attemptsIn = history =>
  history
    .filter(h => h.code === ATTEMPT_CODE || /^attempt made/i.test(h.message ?? ''))
    .map(h => h.message.replace(/^attempt made:?\s*/i, '').trim() || 'No reason given');

/** Apply one parcel's fresh state to its order. Returns what changed, for the run's tally. */
const apply = async (order, fresh) => {
  const kind = readStatus(fresh);
  const set = { 'courierBooking.lastSyncAt': new Date() };
  const unset = {};
  const out = { updated: false, ready: false };

  if (fresh.status && fresh.status !== order.courierBooking.courierStatus) {
    set['courierBooking.courierStatus'] = fresh.status;
    set['courierBooking.courierStatusAt'] = new Date();
    out.updated = true;
  }
  set['courierBooking.history'] = fresh.history;

  // Both fees, in rupees, as the courier reports them (only meaningful once it has settled the parcel).
  if (kind === 'delivered') {
    set['courierBooking.fee'] = fresh.fee;
    set['courierBooking.tax'] = fresh.tax;
  } else if (kind === 'returned') {
    set['courierBooking.fee'] = fresh.reversalFee;
    set['courierBooking.tax'] = fresh.reversalTax;
  }

  if ((kind === 'delivered' || kind === 'returned') && order.courierBooking.confirmable !== kind) {
    set['courierBooking.confirmable'] = kind;
    out.ready = true;
  } else if (kind !== 'delivered' && kind !== 'returned' && order.courierBooking.confirmable) {
    unset['courierBooking.confirmable'] = 1; // the courier changed its mind
    out.updated = true;
  }

  // Failed tries the courier reports that we have not logged yet.
  const reported = attemptsIn(fresh.history);
  const logged = (order.deliveryAttempts ?? []).filter(a => a.note?.startsWith('PostEx:')).length;
  const added = reported.slice(logged).map(reason => ({
    reason: attemptReason(reason),
    note: `PostEx: ${reason}`.slice(0, 200),
    at: new Date()
  }));

  // Filtering on the attempts count means two runs can not both add the same ones.
  const filter = { _id: order._id, status: ORDER_STATUS.DISPATCHED };
  if (added.length) filter.deliveryAttempts = { $size: (order.deliveryAttempts ?? []).length };
  const result = await Order.updateOne(
    filter,
    {
      $set: set,
      ...(Object.keys(unset).length ? { $unset: unset } : {}),
      ...(added.length ? { $push: { deliveryAttempts: { $each: added } } } : {})
    },
    { timestamps: false }
  );
  if (result.modifiedCount === 1 && added.length) out.updated = true;
  if (result.modifiedCount !== 1) return { updated: false, ready: false };

  if (out.ready) {
    await notify({
      business: order.business,
      type: NOTIFICATION_TYPES.COURIER_READY,
      title: `${kind === 'delivered' ? 'Delivered' : 'Returned'}, says ${order.courierBooking.provider === 'postex' ? 'PostEx' : 'the courier'} — #${order.orderNumber} ${order.customerName}`,
      body: 'Open the order to confirm it.',
      link: `/orders/${order._id}`
    });
  }
  return out;
};

/** One pass: ask each connected courier about its parcels that are still out. */
export const runCourierSync = async () => {
  const tally = { checked: 0, updated: 0, ready: 0, errors: 0 };
  const orders = await Order.find({
    status: ORDER_STATUS.DISPATCHED,
    'courierBooking.trackingNumber': { $exists: true },
    courier: { $exists: true }
  })
    .sort({ 'courierBooking.lastSyncAt': 1 })
    .limit(PER_RUN);

  const byCourier = new Map();
  for (const o of orders) {
    const key = String(o.courier);
    if (!byCourier.has(key)) byCourier.set(key, []);
    byCourier.get(key).push(o);
  }

  for (const [courierId, list] of byCourier) {
    let api;
    try {
      ({ api } = await adapterFor(courierId));
    } catch (err) {
      tally.errors += list.length; // not connected any more, or no key: nothing to ask
      logger.warn({ courier: courierId, err: err.message }, 'courier sync skipped');
      continue;
    }

    for (let i = 0; i < list.length; i += BATCH) {
      const group = list.slice(i, i + BATCH);
      let rows;
      try {
        rows = await api.trackBulk(group.map(o => o.courierBooking.trackingNumber));
      } catch (err) {
        // Bulk failed: try them one at a time, so one bad parcel can not hide the rest.
        rows = [];
        for (const o of group) {
          try {
            rows.push({ found: true, ...(await api.track(o.courierBooking.trackingNumber)) });
          } catch (e) {
            tally.errors += 1;
            logger.warn(
              { tracking: o.courierBooking.trackingNumber, err: e.message },
              'parcel not tracked'
            );
          }
        }
      }
      const byNumber = new Map(rows.filter(r => r.found !== false).map(r => [r.trackingNumber, r]));
      for (const o of group) {
        tally.checked += 1;
        const fresh = byNumber.get(o.courierBooking.trackingNumber);
        if (!fresh) continue;
        try {
          const out = await apply(o, fresh);
          if (out.updated) tally.updated += 1;
          if (out.ready) tally.ready += 1;
        } catch (err) {
          tally.errors += 1;
          logger.error({ order: String(o._id), err }, 'courier sync could not apply a parcel');
        }
      }
    }
  }
  return tally;
};

/** Run now and then every 15 minutes; never overlaps itself, never takes the server down. */
export const startCourierSync = ({ everyMs = EVERY_MS } = {}) => {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const t = await runCourierSync();
      Object.assign(status, {
        lastRunAt: new Date().toISOString(),
        lastChecked: t.checked,
        lastUpdated: t.updated,
        lastReady: t.ready,
        lastErrors: t.errors
      });
      if (t.updated || t.ready) logger.info(t, 'courier sync');
    } catch (err) {
      logger.error({ err }, 'courier sync failed');
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return () => clearInterval(timer);
};
