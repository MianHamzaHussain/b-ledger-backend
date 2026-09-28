import Party from '../models/Party.js';
import ErrorResponse from './errorResponse.js';
import { PARTY_TYPES } from './constants.js';

/**
 * Create a customer party straight from the details already on the order (its
 * name + contact number), so an unpaid walk-in never re-asks for them. Upserts
 * by phone within the business so a repeat credit buyer folds into one running
 * account rather than spawning a duplicate statement each visit.
 */
export const upsertCustomerParty = async (business, name, phone, userId) => {
  if (!phone)
    throw new ErrorResponse('A contact number is required to record a customer on credit', 400);
  // Bake the phone into the party name — a common first name ("Ali") stays
  // distinguishable everywhere the party is shown by name alone. Phone is still
  // kept as its own field so dedup-by-phone and phone search keep working.
  const label = `${name} - ${phone}`;
  const party = await Party.findOneAndUpdate(
    { business, type: PARTY_TYPES.CUSTOMER, phone },
    {
      $set: { name: label },
      $setOnInsert: { business, type: PARTY_TYPES.CUSTOMER, phone, createdBy: userId }
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  );
  return party._id;
};
