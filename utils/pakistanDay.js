// The businesses trade in Pakistan, so a "day" — the cash book's, an order's
// daily serial — is a Pakistan day, whatever timezone the server runs in.
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' });

/** A date's Pakistan calendar day, as `YYYY-MM-DD`. */
export const pakistanDay = (date = new Date()) => formatter.format(date);

const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The first instant of a Pakistan day (no daylight saving, so +05:00 is exact). */
export const startOfPakistanDay = day => new Date(`${day}T00:00:00+05:00`);

/** The last millisecond of a Pakistan day. */
export const endOfPakistanDay = day => new Date(startOfPakistanDay(day).getTime() + DAY_MS - 1);

/**
 * A request's date as an instant. A bare `YYYY-MM-DD` means that Pakistan day — the start of it
 * for a lower bound or a record's own date, the end of it for `edge: 'end'` (an inclusive "to").
 * `new Date('2026-10-25')` would be midnight UTC, i.e. 05:00 in Pakistan: right day by luck, and
 * wrong for the whole morning of a range's last day. A full timestamp is used as given.
 */
export const parseBusinessDate = (value, edge = 'start') => {
  if (value instanceof Date) return value;
  if (typeof value === 'string' && DAY_ONLY.test(value)) {
    return edge === 'end' ? endOfPakistanDay(value) : startOfPakistanDay(value);
  }
  return new Date(value);
};
