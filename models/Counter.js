import mongoose from 'mongoose';

/**
 * Atomic named counters — one document per sequence (e.g. `_id: 'order'`).
 *
 * Sequential order numbers must never collide or skip under concurrent
 * creates, so they come from an atomic `$inc` here rather than "count existing
 * + 1" (which races). See `getNextSequence`.
 */
const CounterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 }
});

export default mongoose.model('Counter', CounterSchema);
