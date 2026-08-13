import Customer from '../models/Customer.js';
import { createCrudHandlers } from '../utils/crudController.js';

/**
 * Customers — read and correct only. They are CREATED implicitly by the order
 * flow (upserted by phone), never through a create form, so no create/delete
 * handler is exposed. Scoped to the business like every transactional record.
 *
 * @route  GET  /api/v1/customers      (customers:read — scoped)
 * @route  GET  /api/v1/customers/:id  (customers:read — scoped)
 * @route  PUT  /api/v1/customers/:id  (customers:update — scoped)
 */
const handlers = createCrudHandlers({ model: Customer });

export const { getAll: getCustomers, getOne: getCustomer, update: updateCustomer } = handlers;
