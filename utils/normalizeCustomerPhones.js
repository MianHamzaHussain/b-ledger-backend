import Customer from '../models/Customer.js';
import Order from '../models/Order.js';
import { normalizePhone } from './phone.js';

/**
 * Bring every saved customer's phone to the standard form, merging customers that turn out to be
 * the same person typed differently ("0300-1234567" and "+92 300 1234567").
 *
 * Within a business, the customers that share a standard phone become one: the one already
 * saved in that form (else the earliest) is kept, takes the newest name and city, and the others
 * are removed after their orders are pointed at the survivor. `apply: false` only reports.
 * Run it once, with a backup taken first; running it again changes nothing.
 */
export const normalizeCustomerPhones = async ({ apply = false } = {}) => {
  const report = { checked: 0, rewritten: 0, merged: 0 };
  const groups = new Map();

  for await (const c of Customer.collection.find({})) {
    report.checked += 1;
    const phone = normalizePhone(c.phone);
    const key = `${c.business}:${phone}`;
    if (!groups.has(key)) groups.set(key, { phone, docs: [] });
    groups.get(key).docs.push(c);
  }

  for (const { phone, docs } of groups.values()) {
    const needsWork = docs.length > 1 || docs[0].phone !== phone;
    if (!needsWork) continue;

    const byAge = [...docs].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const survivor = docs.find(d => d.phone === phone) ?? byAge[0];
    const newest = [...docs].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
    const others = docs.filter(d => String(d._id) !== String(survivor._id));

    if (survivor.phone !== phone) report.rewritten += 1;
    report.merged += others.length;
    if (!apply) continue;

    // Remove the duplicates first: the unique {business, phone} index would refuse the rewrite.
    if (others.length > 0) {
      const ids = others.map(o => o._id);
      await Order.collection.updateMany(
        { customer: { $in: ids } },
        { $set: { customer: survivor._id } }
      );
      await Customer.collection.deleteMany({ _id: { $in: ids } });
    }
    await Customer.collection.updateOne(
      { _id: survivor._id },
      {
        $set: {
          phone,
          name: newest.name,
          ...(newest.city && { city: newest.city }),
          createdAt: byAge[0].createdAt
        }
      }
    );
  }
  return report;
};
