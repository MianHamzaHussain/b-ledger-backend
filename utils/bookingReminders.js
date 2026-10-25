import Order from '../models/Order.js';
import { notify } from './notify.js';
import { pakistanDay } from './pakistanDay.js';
import { NOTIFICATION_TYPES, ORDER_STATUS } from './constants.js';
import logger from './logger.js';

/** Alerts go out in working hours, not at midnight: the first run at or after this Pakistan hour. */
const ALERT_FROM_HOUR = 9;
const EVERY_MS = 10 * 60 * 1000;
const BATCH = 500;

const hourFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Karachi',
  hour: '2-digit',
  hour12: false
});

const status = { lastRunAt: null, lastChecked: 0, lastAlerted: 0 };

/** For the health probe: a dead scheduler shows up as an old `lastRunAt`, not as silence. */
export const reminderStatus = () => ({ ...status });

const niceDay = day => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC'
  });
};

/**
 * Tell people a booked order is due (its date is today or earlier), once a day until it is
 * moved out of "booked". An order is CLAIMED first — one atomic update stamps today's date on
 * it — and only the run that wins the stamp sends the alert, so overlapping runs or a second
 * API process can never send it twice (the database is the lock). If sending fails the stamp
 * is cleared and the next run tries again. Safe to run as often as you like.
 */
export const runBookingReminders = async (now = new Date()) => {
  const result = { checked: 0, alerted: 0 };
  if (Number(hourFormat.format(now)) < ALERT_FROM_HOUR) return result;

  const today = pakistanDay(now);
  const due = await Order.find(
    {
      status: ORDER_STATUS.BOOKED,
      bookedFor: { $lte: today },
      bookingAlertedOn: { $ne: today }
    },
    'business orderNumber customerName bookedFor'
  )
    .limit(BATCH)
    .lean();
  result.checked = due.length;

  for (const order of due) {
    const claim = await Order.updateOne(
      { _id: order._id, status: ORDER_STATUS.BOOKED, bookingAlertedOn: { $ne: today } },
      { $set: { bookingAlertedOn: today } },
      { timestamps: false }
    );
    if (claim.modifiedCount !== 1) continue; // another run got it

    const overdue = order.bookedFor < today;
    const sent = await notify({
      business: order.business,
      type: NOTIFICATION_TYPES.BOOKING_DUE,
      title: `${overdue ? 'Booked order overdue' : 'Booked order due today'} — #${order.orderNumber} ${order.customerName}`,
      body: `Booked for ${niceDay(order.bookedFor)}. Dispatch it now.`,
      link: `/orders/${order._id}`
    });
    if (sent) {
      result.alerted += 1;
    } else {
      await Order.updateOne(
        { _id: order._id },
        { $unset: { bookingAlertedOn: 1 } },
        { timestamps: false }
      );
    }
  }
  return result;
};

/**
 * Run the reminders now (catching up after downtime) and then every ten minutes. A run that
 * is still going is never overlapped, a failed run is logged and never takes the server down,
 * and the timer does not keep the process alive on shutdown. Returns a function that stops it.
 */
export const startBookingReminders = ({ everyMs = EVERY_MS } = {}) => {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const out = await runBookingReminders();
      Object.assign(status, {
        lastRunAt: new Date().toISOString(),
        lastChecked: out.checked,
        lastAlerted: out.alerted
      });
      if (out.alerted > 0) logger.info(out, 'booking reminders sent');
    } catch (err) {
      logger.error({ err }, 'booking reminders failed');
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return () => clearInterval(timer);
};
