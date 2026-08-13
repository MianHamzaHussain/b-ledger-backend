import mongoose from 'mongoose';

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
    phone: {
      type: String,
      required: [true, 'Please add a contact number'],
      trim: true
    },
    city: {
      type: String,
      trim: true,
      maxlength: [60, 'City can not be more than 60 characters']
    },
    createdBy: { type: mongoose.Schema.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

/** One record per phone within a business — the dedup key. */
CustomerSchema.index({ business: 1, phone: 1 }, { unique: true });

export default mongoose.model('Customer', CustomerSchema);
