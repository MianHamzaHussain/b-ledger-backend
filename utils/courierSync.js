import Order from '../models/Order.js';
import { notify } from './notify.js';
import ErrorResponse from './errorResponse.js';
import { adapterFor, providerName } from './couriers/index.js';
import { NOTIFICATION_TYPES, ORDER_STATUS } from './constants.js';
import logger from './logger.js';
import {
  FINAL_PHASES,
  NEEDS_ATTENTION,
  PHASES,
  orderedSteps,
  phaseOf
} from './couriers/statusWords.js';
import { checkHeldCities } from './cityWatch.js';
import { recordCourierWallets } from './courierWallet.js';
import { adoptTypedParcels } from './couriers/adopt.js';

/**
 * Keep dispatched parcels in step with the courier. PostEx has no webhook, so this ASKS: every 10
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
// 10 minutes; COURIER_SYNC_SECONDS shortens it for demos (never below 10 s).
const EVERY_MS = Math.max(Number(process.env.COURIER_SYNC_SECONDS) || 10 * 60, 10) * 1000;
const BATCH = 20;
const CITY_CHECK_MS = 60 * 60 * 1000;
const WALLET_CHECK_MS = 60 * 60 * 1000;
const PER_RUN = 300;
// A parcel that has not moved for this long raises an alert, once.
const STUCK_MS = 3 * 24 * 60 * 60 * 1000;

const status = {
  lastRunAt: null,
  lastChecked: 0,
  lastUpdated: 0,
  lastReady: 0,
  lastErrors: 0,
  lastAdopted: 0
};
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
// PostEx writes the reason as a short code first: "RFD(REFUSED TO RECEIVE)", "CNA(CNA)", "HCR(HOLD ON CONSIGNEE REQUEST)".
const ATTEMPT_CODES = { RFD: 'refused', CNA: 'not-available', HCR: 'rescheduled' };

export const attemptReason = message => {
  const code = /^([A-Z]{2,4})(?![A-Za-z])/.exec(message.trim())?.[1];
  if (code && ATTEMPT_CODES[code]) return ATTEMPT_CODES[code];
  const m = message.toLowerCase();
  if (/reschedul|later|another day|postpone|delay|tomorrow/.test(m)) return 'rescheduled';
  if (/refus|not interested|cancel/.test(m)) return 'refused';
  if (/wrong|incomplete|incorrect|address|location/.test(m)) return 'wrong-address';
  if (/unreach|not respond|no answer|switched off|phone|contact/.test(m)) return 'unreachable';
  if (/not available|not at home|closed|nobody|absent/.test(m)) return 'not-available';
  return 'other';
};

// "Merchant Request For Re-Attempt" carries the attempt code, but it is the SHOP asking PostEx to try again —
// not a delivery that failed — so it is never counted as a try (it was filed as "other" and inflated the count).
const isShopRequest = message => /^merchant request/i.test((message ?? '').trim());

const attemptsIn = history =>
  history
    .filter(
      h =>
        (h.code === ATTEMPT_CODE || /^attempt made/i.test(h.message ?? '')) &&
        !isShopRequest(h.message)
    )
    .map(h => h.message.replace(/^attempt made:?\s*/i, '').trim() || 'No reason given');

/** Apply one parcel's fresh state to its order. Returns what changed, for the run's tally. */
const apply = async (order, fresh, { auto = null, confirm = null, keepSeen = false } = {}) => {
  const provider = order.courierBooking.provider;
  const phase = phaseOf(fresh, provider);
  // A parcel WE cancelled at the courier arrives under a "returned" code: that is not a return to confirm.
  const kind = phase === PHASES.CANCELLED ? 'moving' : readStatus(fresh);
  const set = { 'courierBooking.lastSyncAt': new Date() };
  const unset = {};
  const out = { updated: false, ready: false };

  if (fresh.status && fresh.status !== order.courierBooking.courierStatus) {
    set['courierBooking.courierStatus'] = fresh.status;
    set['courierBooking.courierStatusAt'] = new Date();
    out.updated = true;
  }
  // The journey in time order, each step with the courier's own time (when it sends one) and with when WE first
  // noticed it. A step already stored keeps its stamp, so "seen 3:15 pm" never slides forward on a later check;
  // steps are matched by what they say and when, not by position, so a reordered list does not reset them.
  const noticed = new Date();
  const stamp = h => `${h.code}|${h.message}|${h.at ? new Date(h.at).getTime() : ''}`;
  const seenBefore = new Map();
  for (const h of order.courierBooking.history ?? []) {
    if (h.seenAt) {
      seenBefore.set(stamp(h), h.seenAt);
      seenBefore.set(`${h.code}|${h.message}|`, h.seenAt);
    }
  }
  const journey = orderedSteps(fresh.history).map(h => ({
    code: h.code,
    message: h.message,
    at: h.at ? new Date(h.at) : undefined,
    seenAt: seenBefore.get(stamp(h)) ?? seenBefore.get(`${h.code}|${h.message}|`) ?? noticed
  }));
  set['courierBooking.history'] = journey;
  const newest = journey.at(-1);
  const movedAt = newest ? (newest.at ?? newest.seenAt) : undefined;
  if (newest) {
    set['courierBooking.lastStep'] = { message: newest.message, at: movedAt };
    set['courierBooking.lastMoveAt'] = movedAt;
  }

  // The courier's state in plain phases, and whether it needs a person's eye.
  const phaseChanged = phase !== order.courierBooking.phase;
  if (phaseChanged) {
    set['courierBooking.phase'] = phase;
    set['courierBooking.phaseAt'] = noticed;
    out.updated = true;
  }
  // A parcel silent for 3 days needs a person too — whatever stage it is stuck in (a final stage is never stuck).
  const stuck = Boolean(movedAt) && !FINAL_PHASES.has(phase) && noticed - movedAt > STUCK_MS;
  if (NEEDS_ATTENTION.has(phase) || stuck) set['courierBooking.needsAttention'] = true;
  else if (order.courierBooking.needsAttention) unset['courierBooking.needsAttention'] = 1;

  // The two alerts below ring once: the flag is set with the change and cleared when the cause goes away.
  const startedReturning = phase === PHASES.RETURNING && !order.courierBooking.returningAlertedAt;
  if (startedReturning) set['courierBooking.returningAlertedAt'] = noticed;
  else if (phase !== PHASES.RETURNING && order.courierBooking.returningAlertedAt) {
    unset['courierBooking.returningAlertedAt'] = 1; // it went out for delivery again
  }
  const startedStuck = stuck && !order.courierBooking.stuckAlertedAt;
  if (startedStuck) set['courierBooking.stuckAlertedAt'] = noticed;
  else if (!stuck && order.courierBooking.stuckAlertedAt)
    unset['courierBooking.stuckAlertedAt'] = 1;

  // Both fees, in rupees, as the courier reports them (only meaningful once it has settled the parcel).
  if (kind === 'delivered') {
    set['courierBooking.fee'] = fresh.fee;
    set['courierBooking.tax'] = fresh.tax;
  } else if (kind === 'returned') {
    set['courierBooking.fee'] = fresh.reversalFee;
    set['courierBooking.tax'] = fresh.reversalTax;
  }

  // How many checks in a row have said the same final thing: an automatic confirm waits for two, because
  // delivered can not be taken back once sales, cost and stock are posted.
  const settled = kind === 'delivered' || kind === 'returned';
  const seenCount = settled
    ? (order.courierBooking.seenKind === kind ? (order.courierBooking.seenCount ?? 0) : 0) + 1
    : 0;
  // "Refresh now" (keepSeen) must not count: two quick taps are not two checks apart in time.
  if (keepSeen) {
    // leave the count as it was
  } else if (settled) {
    set['courierBooking.seenKind'] = kind;
    set['courierBooking.seenCount'] = seenCount;
  } else if (order.courierBooking.seenKind) {
    unset['courierBooking.seenKind'] = 1;
    unset['courierBooking.seenCount'] = 1;
  }

  if ((kind === 'delivered' || kind === 'returned') && order.courierBooking.confirmable !== kind) {
    set['courierBooking.confirmable'] = kind;
    out.ready = true;
  } else if (kind !== 'delivered' && kind !== 'returned' && order.courierBooking.confirmable) {
    unset['courierBooking.confirmable'] = 1; // the courier changed its mind
    out.updated = true;
  }

  // Failed tries the courier reports that we have not logged yet.
  // Each attempt's note carries the courier's name, which is also how earlier ones are counted.
  const prefix = `${providerName(provider)}:`;
  const reported = attemptsIn(orderedSteps(fresh.history));
  const logged = (order.deliveryAttempts ?? []).filter(a => a.note?.startsWith(prefix)).length;
  const added = reported.slice(logged).map(reason => ({
    reason: attemptReason(reason),
    note: `${prefix} ${reason}`.slice(0, 200),
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

  const who = `#${order.orderNumber} ${order.customerName}`;
  // A new failed try rings the bell once, with the courier's reason (the attempts filter above means
  // a second run adds nothing, so it can not ring twice).
  if (added.length) {
    await notify({
      business: order.business,
      type: NOTIFICATION_TYPES.COURIER_ISSUE,
      title: `Delivery try failed — ${who}`,
      body: added.at(-1).note.slice(prefix.length).trim(),
      link: `/orders/${order._id}`
    });
  }
  // On its way back: rings once when the return starts, so nobody has to ask where it is.
  if (startedReturning) {
    await notify({
      business: order.business,
      type: NOTIFICATION_TYPES.COURIER_ISSUE,
      title: `Coming back — ${who}`,
      body: newest?.message ?? 'The courier is returning this parcel.',
      link: `/orders/${order._id}`
    });
  }
  if (startedStuck) {
    await notify({
      business: order.business,
      type: NOTIFICATION_TYPES.COURIER_ISSUE,
      title: `No courier update for 3 days — ${who}`,
      body: newest?.message ? `Last step: ${newest.message}` : 'Ask the courier where it is.',
      link: `/orders/${order._id}`
    });
  }
  // "Delivery under review" rings once, when the parcel first enters it.
  if (phaseChanged && phase === PHASES.UNDER_REVIEW) {
    await notify({
      business: order.business,
      type: NOTIFICATION_TYPES.COURIER_ISSUE,
      title: `The courier is reviewing the delivery — ${who}`,
      body: 'Open the order to see what it says.',
      link: `/orders/${order._id}`
    });
  }

  if (out.ready) {
    await notify({
      business: order.business,
      type: NOTIFICATION_TYPES.COURIER_READY,
      title: `${kind === 'delivered' ? 'Delivered' : 'Returned'}, says ${providerName(order.courierBooking.provider)} — #${order.orderNumber} ${order.customerName}`,
      body: auto
        ? 'It will be marked automatically at the next check.'
        : 'Open the order to confirm it.',
      link: `/orders/${order._id}`
    });
  }
  // Two matching checks and the courier's switch is on: mark it exactly as a person's tap would.
  if (auto && confirm && settled && seenCount >= 2) {
    const done = await confirm({ id: order._id, user: { id: auto }, auto: true });
    if (done.ok) out.autoConfirmed = true;
    else
      logger.warn({ order: String(order._id), reason: done.reason }, 'automatic confirm skipped');
  }
  return out;
};

/**
 * Ask the courier about ONE parcel right now — for the "Refresh now" button, so nobody waits for the
 * next 10-minute pass while a customer is on the phone. Applies exactly what the pass would. A second
 * tap within a few seconds reuses the first answer instead of asking again.
 */
const REFRESH_COOLDOWN_MS = 10_000;
export const refreshParcel = async order => {
  const tracking = order.courierBooking?.trackingNumber;
  if (order.status !== ORDER_STATUS.DISPATCHED || !tracking || !order.courier) {
    throw new ErrorResponse(
      'Only a dispatched parcel booked through a courier can be refreshed',
      400
    );
  }
  const last = order.courierBooking.lastSyncAt;
  if (last && Date.now() - new Date(last).getTime() < REFRESH_COOLDOWN_MS) return order;

  const { api } = await adapterFor(order.courier);
  const fresh = await api.track(tracking);
  await apply(order, fresh, { keepSeen: true });
  return Order.findById(order._id);
};

/**
 * "Refresh all" for ONE business: the same check the 10-minute pass makes, now, for that business's parcels
 * that are out. It never counts as one of the two matching checks an automatic confirm waits for (two quick
 * taps are not two checks apart in time), and a business can ask once a minute. The cool-down lives in this
 * process — the API runs as one systemd process, so that is the whole server.
 */
const REFRESH_ALL_COOLDOWN_MS = 60_000;
const refreshedAllAt = new Map();
export const clearRefreshAllCooldown = () => refreshedAllAt.clear();

export const refreshBusinessParcels = async business => {
  const key = String(business);
  const last = refreshedAllAt.get(key);
  if (last && Date.now() - last < REFRESH_ALL_COOLDOWN_MS) {
    const wait = Math.ceil((REFRESH_ALL_COOLDOWN_MS - (Date.now() - last)) / 1000);
    throw new ErrorResponse(`Checked a moment ago — try again in ${wait} seconds`, 429);
  }
  refreshedAllAt.set(key, Date.now());
  const { checked, updated, errors } = await runCourierSync({ business, keepSeen: true });
  return { checked, updated, errors };
};

/** One pass: ask each connected courier about its parcels that are still out. */
export const runCourierSync = async ({
  confirm = null,
  business = null,
  keepSeen = false
} = {}) => {
  const tally = { checked: 0, updated: 0, ready: 0, autoConfirmed: 0, errors: 0, adopted: 0 };
  // First take over any tracking number a person typed in by hand, so those parcels are followed in this same pass.
  try {
    tally.adopted = (await adoptTypedParcels({ business })).adopted;
  } catch (err) {
    logger.error({ err }, 'typed tracking numbers could not be taken over');
  }
  const orders = await Order.find({
    status: ORDER_STATUS.DISPATCHED,
    'courierBooking.trackingNumber': { $exists: true },
    courier: { $exists: true },
    ...(business ? { business } : {})
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
    let auto = null;
    try {
      let party;
      ({ api, party } = await adapterFor(courierId));
      // The person the books name when this courier's parcels are marked automatically (switch off = none).
      if (party.integration?.autoConfirm) auto = party.integration.autoConfirmBy ?? null;
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
          const out = await apply(o, fresh, { auto, confirm, keepSeen });
          if (out.updated) tally.updated += 1;
          if (out.ready) tally.ready += 1;
          if (out.autoConfirmed) tally.autoConfirmed += 1;
        } catch (err) {
          tally.errors += 1;
          logger.error({ order: String(o._id), err }, 'courier sync could not apply a parcel');
        }
      }
    }
  }
  return tally;
};

/** Run now and then every 10 minutes; never overlaps itself, never takes the server down. */
export const startCourierSync = ({ everyMs = EVERY_MS, confirm = null } = {}) => {
  let running = false;
  let lastCityCheck = 0;
  let lastWalletCheck = 0;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      // Held orders: about once an hour, ask whether a refused city has reopened.
      if (Date.now() - lastCityCheck >= CITY_CHECK_MS) {
        lastCityCheck = Date.now();
        await checkHeldCities().catch(err => logger.error({ err }, 'held city check failed'));
      }
      // Couriers whose payments an admin chose to record: paid parcels into the wallet, returned parcels' charges out of it.
      if (Date.now() - lastWalletCheck >= WALLET_CHECK_MS) {
        lastWalletCheck = Date.now();
        await recordCourierWallets().catch(err =>
          logger.error({ err }, 'courier wallet check failed')
        );
      }
      const t = await runCourierSync({ confirm });
      Object.assign(status, {
        lastRunAt: new Date().toISOString(),
        lastChecked: t.checked,
        lastUpdated: t.updated,
        lastReady: t.ready,
        lastErrors: t.errors,
        lastAdopted: t.adopted
      });
      if (t.updated || t.ready || t.adopted) logger.info(t, 'courier sync');
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
