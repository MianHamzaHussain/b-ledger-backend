import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, makeBusiness, oid, userId } from './helpers/db.js';
import Order from '../models/Order.js';
import { ORDER_LIST_FIELDS } from '../utils/orderListFields.js';

/**
 * The Orders list shows what was ordered, so the row carries each line's name, size and quantity
 * — and nothing that is money or cost.
 */
before(connect);
after(disconnect);
afterEach(clear);

test('a list row carries what was ordered, with no price or cost', async () => {
  const biz = await makeBusiness();
  await new Order({
    business: biz._id,
    customer: oid(),
    customerName: 'Sana',
    contactNumber: '03001112222',
    createdBy: userId,
    items: [
      {
        product: oid(),
        variantId: oid(),
        productName: 'Beech Tree Mehfil',
        variantLabel: 'M',
        quantity: 2,
        unitPrice: 4500,
        unitCost: 2500
      }
    ],
    customWork: [{ description: 'Shorten sleeves', price: 300 }]
  }).save();

  const [row] = await Order.find({ business: biz._id }).select(ORDER_LIST_FIELDS).lean();
  // The row shows who it is for by phone number — WhatsApp customers are known by it.
  assert.equal(row.contactNumber, '03001112222');
  assert.deepEqual(
    Object.keys(row.items[0]).sort(),
    ['productName', 'quantity', 'variantLabel'].sort()
  );
  assert.equal(row.items[0].productName, 'Beech Tree Mehfil');
  assert.equal(row.customWork[0].description, 'Shorten sleeves');
  assert.equal(row.customWork[0].price, undefined);
  assert.equal(row.items[0].unitCost, undefined);
});
