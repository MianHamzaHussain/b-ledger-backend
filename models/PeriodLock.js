import mongoose from 'mongoose';

/**
 * A closed accounting period. Once the books are locked through a date, no entry
 * dated on or before it can be posted — so last month's reported numbers can't
 * silently change after the fact. Unlocking (deleting the latest lock) is a
 * deliberate, permissioned action.
 */
const PeriodLockSchema = new mongoose.Schema(
  {
    business: {
      type: mongoose.Schema.ObjectId,
      ref: 'Business',
      required: [true, 'Please select a business']
    },
    /** Entries dated on or before this are frozen. */
    periodEnd: { type: Date, required: [true, 'Please choose the lock date'] },
    lockedBy: { type: mongoose.Schema.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

PeriodLockSchema.index({ business: 1, periodEnd: -1 });

export default mongoose.model('PeriodLock', PeriodLockSchema);
