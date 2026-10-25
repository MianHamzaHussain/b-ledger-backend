import mongoose from 'mongoose';
import { normalizeCity } from '../utils/cities.js';
import { normalizePhone } from '../utils/phone.js';

/**
 * A customer of one business, deduped by phone.
 *
 * Upserted from every order (see orderController), so repeat buyers collapse to
 * one record and you build a contact list to reach them again. Per business —
 * the same person buying from two brands is two customers, which keeps each
 * brand's list its own and fits the `scope: 'own'` permission model.
 */
const CustomerSchema = new mongoose.Schema(
  {
    business: {
      type: mongoose.Schema.ObjectId,
      ref: 'Business',
      required: true
    },
    name: {
      type: String,
      required: [true, 'Please add a customer name'],
      trim: true,
      maxlength: [100, 'Name can not be more than 100 characters']
    },
    // One spelling per number (03XXXXXXXXX), so the same person typed three ways is one customer.
    phone: {
      type: String,
      required: [true, 'Please add a contact number'],
      trim: true,
      set: normalizePhone
    },
    city: {
      type: String,
      trim: true,
      maxlength: [60, 'City can not be more than 60 characters'],
      // One spelling per place, so the same buyer's city matches their orders'.
      set: normalizeCity
    },
    /** Where this customer came from: an order (the usual), added by hand, or imported. */
    source: { type: String, enum: ['order', 'manual', 'import'] },
    /** A line about them ("met at the exhibition") — only for customers added by hand or imported. */
    note: {
      type: String,
      trim: true,
      maxlength: [200, 'Note can not be more than 200 characters']
    },
    createdBy: { type: mongoose.Schema.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

/** One record per phone within a business — the dedup key. */
CustomerSchema.index({ business: 1, phone: 1 }, { unique: true });

export default mongoose.model('Customer', CustomerSchema);
