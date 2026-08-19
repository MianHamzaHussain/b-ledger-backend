import Counter from '../models/Counter.js';

/**
 * Returns the next value of a named sequence, atomically.
 *
 * `findOneAndUpdate` with `$inc` is a single atomic operation, so two orders
 * created at the same instant get 7 and 8 — never both 7, never a gap. This is
 * why order numbers come from here and not from counting documents.
 *
 * @param {string} name  sequence id, e.g. 'order'
 * @returns {Promise<number>}
 */
export const getNextSequence = async name => {
  const counter = await Counter.findByIdAndUpdate(
    name,
    { $inc: { seq: 1 } },
    { returnDocument: 'after', upsert: true }
  );
  return counter.seq;
};
