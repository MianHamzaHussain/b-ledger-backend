import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hideCosts, requirePermission } from '../middlewares/permissions.js';
import { userCan } from '../utils/permissions.js';

/**
 * What an article cost is a trade secret: only people who may "See costs" get
 * cost fields in any response, and production (all costs) needs it outright.
 */

const role = (permissions, fullAccess = false) => ({ role: { permissions, fullAccess } });
const staff = role([{ resource: 'orders', actions: ['read', 'create'], scope: 'own' }]);
const partner = role([{ resource: 'costs', actions: ['read'], scope: 'all' }]);
const admin = role([], true);

/** Run hideCosts for a user and return the body the client would receive. */
const respond = (user, body) =>
  new Promise(resolve => {
    const res = { json: sent => resolve(sent) };
    hideCosts({ user }, res, () => res.json(body));
  });

const order = {
  _id: 'o1',
  total: 7000,
  items: [{ productName: 'Lawn suit', unitPrice: 7000, unitCost: 3100 }],
  variants: [{ label: 'M', salePrice: 7000, costPrice: 3100, stock: 4 }],
  lines: [{ unitCostPaisa: 310000, unitPricePaisa: 700000, totalCostPaisa: 310000 }]
};

test('staff never receive a cost field, at any depth', async () => {
  const body = await respond(staff, { success: true, data: [order] });
  const [o] = body.data;
  assert.equal(o.items[0].unitCost, undefined);
  assert.equal(o.variants[0].costPrice, undefined);
  assert.equal(o.lines[0].unitCostPaisa, undefined);
  assert.equal(o.lines[0].totalCostPaisa, undefined);
  // Everything else is untouched.
  assert.equal(o.items[0].unitPrice, 7000);
  assert.equal(o.variants[0].stock, 4);
  assert.equal(o.lines[0].unitPricePaisa, 700000);
});

test('partners with "See costs" and admins get costs as they are', async () => {
  for (const user of [partner, admin]) {
    const body = await respond(user, { success: true, data: order });
    assert.equal(body.data.items[0].unitCost, 3100);
    assert.equal(body.data.variants[0].costPrice, 3100);
  }
});

test('a deny override takes "See costs" away again', () => {
  const denied = {
    ...partner,
    permissionOverrides: [{ resource: 'costs', actions: ['read'], effect: 'deny' }]
  };
  assert.equal(userCan(denied, 'costs', 'read'), false);
  assert.equal(userCan(partner, 'costs', 'read'), true);
});

test('production refuses anyone without "See costs"', () => {
  const guard = requirePermission('costs', 'read');
  const outcome = user =>
    new Promise(resolve => guard({ user }, {}, err => resolve(err?.statusCode ?? 'ok')));

  return Promise.all([outcome(staff), outcome(partner), outcome(admin)]).then(results =>
    assert.deepEqual(results, [403, 'ok', 'ok'])
  );
});
