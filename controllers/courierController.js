import Party from '../models/Party.js';
import Order from '../models/Order.js';
import Account from '../models/Account.js';
import asyncHandler from '../middlewares/asyncHandler.js';
import ErrorResponse from '../utils/errorResponse.js';
import { partyBalancesByIds } from '../utils/ledger.js';
import { fromPaisa } from '../utils/money.js';
import { PROVIDER_FORMS } from '../utils/couriers/index.js';
import { createCourier } from '../utils/couriers/setup.js';
import { ORDER_STATUS, PARTY_TYPES } from '../utils/constants.js';
import { view } from './courierConnectionController.js';

/**
 * The Couriers tab: one place to add a courier and see how each is connected. A courier is still a Khata party —
 * this is a front door, so balances, statements and every report keep working untouched.
 *
 * @route  GET   /api/v1/couriers/providers   (couriers:read)
 * @route  GET   /api/v1/couriers?business=   (couriers:read — scoped)
 * @route  POST  /api/v1/couriers             (couriers:create — scoped)
 */
export const getProviders = asyncHandler(async (req, res) => {
  const data = Object.entries(PROVIDER_FORMS).map(([id, form]) => ({ id, ...form }));
  res.status(200).json({ success: true, data });
});

export const listCouriers = asyncHandler(async (req, res) => {
  const { business } = req.query;
  if (!business) throw new ErrorResponse('Choose a business', 400);
  // The same scope rule as every other list: a business outside the person's own is simply not found.
  const allowed = req.accessFilter?.business?.$in;
  if (allowed && !allowed.map(String).includes(String(business))) {
    throw new ErrorResponse('Not found', 404);
  }

  const couriers = await Party.find({ business, type: PARTY_TYPES.COURIER }).sort('name');
  const ids = couriers.map(c => c._id);
  const [balances, out, wallets] = await Promise.all([
    partyBalancesByIds(ids),
    Order.aggregate([
      { $match: { courier: { $in: ids }, status: ORDER_STATUS.DISPATCHED } },
      { $group: { _id: '$courier', n: { $sum: 1 } } }
    ]),
    Account.find({ business, courier: { $in: ids } }).select('name courier')
  ]);
  const outBy = new Map(out.map(o => [String(o._id), o.n]));
  const walletBy = new Map(wallets.map(w => [String(w.courier), w]));

  const data = couriers.map(c => {
    const wallet = walletBy.get(String(c._id));
    return {
      _id: c._id,
      name: c.name,
      phone: c.phone ?? null,
      note: c.note ?? null,
      isActive: c.isActive,
      connection: view(c),
      balance: fromPaisa(balances[String(c._id)] || 0),
      parcelsOut: outBy.get(String(c._id)) ?? 0,
      wallet: wallet ? { _id: wallet._id, name: wallet.name } : null
    };
  });
  res.status(200).json({ success: true, count: data.length, data });
});

export const addCourier = asyncHandler(async (req, res) => {
  const { business, ...body } = req.body;
  const out = await createCourier({ business, body, user: req.user });
  res.status(201).json({
    success: true,
    data: {
      courier: { _id: out.party._id, name: out.party.name, connection: view(out.party) },
      addresses: out.addresses,
      needsPickup: out.needsPickup,
      walletMade: out.walletMade
    }
  });
});
