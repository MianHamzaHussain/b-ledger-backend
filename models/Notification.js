import mongoose from 'mongoose';
import { NOTIFICATION_TYPES } from '../utils/constants.js';

/**
 * An in-app alert, scoped to a business. Everyone assigned to that business sees
 * it (admins see all) — so it's business-wide, not per-user. Read state is
 * per-user via `readBy`: a notification is "unread" for you until your id is in
 * that array, which is what the bell's badge counts.
 */
const NotificationSchema = new mongoose.Schema(
  {
    business: {
      type: mongoose.Schema.ObjectId,
      ref: 'Business',
      required: [true, 'Please select a business']
    },
    type: { type: String, enum: Object.values(NOTIFICATION_TYPES), required: true },
    title: { type: String, required: true, trim: true },
    body: { type: String, trim: true },
    /** Where the client navigates when the notification is tapped, e.g. '/orders'. */
    link: { type: String },
    /** User ids that have read it. */
    readBy: [{ type: mongoose.Schema.ObjectId, ref: 'User' }]
  },
  { timestamps: true }
);

NotificationSchema.index({ business: 1, createdAt: -1 });

export default mongoose.model('Notification', NotificationSchema);
