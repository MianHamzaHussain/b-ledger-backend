import { ORDER_STATUS } from './constants.js';
import { userCan } from './permissions.js';
import { ACTIVITY_CAP } from '../models/Order.js';

/** "Rs 13,500" — the same wording the rest of the order screens use. */
export const rupees = amount => `Rs ${Number(amount).toLocaleString('en-PK')}`;

/**
 * The order's activity log: every change after the order was taken that is not a status step, with
 * who made it and what it was before. Written in one place so a controller adds one line and no path
 * has to remember a format. The entry rides the same `order.save()` as the change itself, so the
 * log and the change succeed or fail together.
 */

/** Long text is cut so one note can not fill the document; the full note still lives on the order. */
const SHORT = 200;
const short = value => {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim();
  return text.length > SHORT ? `${text.slice(0, SHORT - 1)}…` : text;
};

/**
 * Add one event to the order (in memory — the caller's `order.save()` persists it). `user` is the
 * signed-in person (`req.user`); leave it out and pass `system: true` for the courier check.
 */
export const logActivity = (order, user, { kind, text, from, to, system }) => {
  order.activity.push({
    kind,
    text,
    from: short(from),
    to: short(to),
    at: new Date(),
    by: user?.id ?? user?._id,
    system: system ? true : undefined
  });
  if (order.activity.length > ACTIVITY_CAP) order.activity = order.activity.slice(-ACTIVITY_CAP);
};

/** Log a changed free-text field once, in plain words; an unchanged value logs nothing. */
export const logTextChange = (order, user, { kind, label, before, after }) => {
  const was = short(before);
  const now = short(after);
  if ((was ?? '') === (now ?? '')) return false;
  const verb = !was ? 'added' : !now ? 'removed' : 'changed';
  logActivity(order, user, { kind, text: `${label} ${verb}`, from: was, to: now });
  return true;
};

/**
 * One event per CHANGED field of an edit — "Changed delivery address", not "order updated" — so the
 * timeline says what moved. `fields` is `[{ key, label }]` read from `before` (a plain snapshot taken
 * before the edit) and the order after it.
 */
export const logFieldChanges = (order, user, before, fields) => {
  for (const { key, label } of fields) {
    logTextChange(order, user, {
      kind: 'details',
      label,
      before: before[key],
      after: order[key]
    });
  }
};

/** What the lines add up to, as one short sentence: "2 items · Rs 13,500". */
export const itemsSummary = order => {
  const count = order.items.reduce((s, i) => s + i.quantity, 0) + (order.customWork?.length ?? 0);
  return `${count} item${count === 1 ? '' : 's'} · ${rupees(order.total)}`;
};

/**
 * The timeline the order page shows: status steps and activity merged, newest first. Cost-related
 * events are left out unless the reader may see costs — the amounts sit in the sentence, where the
 * route's field stripper cannot reach them.
 */
export const buildTimeline = (order, user) => {
  const canSeeCosts = userCan(user, 'costs', 'read');

  const steps = (order.statusHistory ?? []).map(e => ({
    kind: 'status',
    status: e.status,
    text: STATUS_WORDS[e.status] ?? e.status,
    note: e.note,
    at: e.at,
    by: e.by
  }));
  const changes = (order.activity ?? [])
    .filter(e => canSeeCosts || e.kind !== 'cost')
    .map(e => ({
      kind: e.kind,
      text: e.text,
      from: e.from,
      to: e.to,
      at: e.at,
      by: e.by,
      system: e.system
    }));

  return [...steps, ...changes].sort((a, b) => new Date(b.at) - new Date(a.at));
};

const STATUS_WORDS = {
  [ORDER_STATUS.PENDING]: 'Order placed',
  [ORDER_STATUS.BOOKED]: 'Booked for later',
  [ORDER_STATUS.CONFIRMED]: 'Confirmed',
  [ORDER_STATUS.DISPATCHED]: 'Dispatched',
  [ORDER_STATUS.DELIVERED]: 'Delivered',
  [ORDER_STATUS.CANCELLED]: 'Cancelled',
  [ORDER_STATUS.RETURNED]: 'Returned',
  [ORDER_STATUS.EXCHANGED]: 'Exchanged',
  [ORDER_STATUS.REFUNDED]: 'Refunded'
};
