import Customer from '../models/Customer.js';
import ErrorResponse from './errorResponse.js';
import { normalizePhone } from './phone.js';

/**
 * Refuse an order for a blocked customer unless the person chose "create anyway" — enforced here, on the
 * server, so it does not depend on the form. Returns the record to keep on the order when the block was
 * overridden (who, when, why they were blocked), or undefined when the customer is not blocked.
 */
export const assertNotBlocked = async (business, contactNumber, confirmBlocked, user) => {
  const customer = await Customer.findOne({
    business,
    phone: normalizePhone(contactNumber),
    isBlocked: true
  }).select('name blockedReason');
  if (!customer) return undefined;

  if (!confirmBlocked) {
    throw new ErrorResponse(
      `${customer.name} is blocked${customer.blockedReason ? `: ${customer.blockedReason}` : ''}. Tick “create anyway” to continue.`,
      400
    );
  }
  return { by: user.id, at: new Date(), reason: customer.blockedReason };
};
