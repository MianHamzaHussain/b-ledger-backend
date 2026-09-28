// The businesses trade in Pakistan, so a "day" — the cash book's, an order's
// daily serial — is a Pakistan day, whatever timezone the server runs in.
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' });

/** A date's Pakistan calendar day, as `YYYY-MM-DD`. */
export const pakistanDay = (date = new Date()) => formatter.format(date);
