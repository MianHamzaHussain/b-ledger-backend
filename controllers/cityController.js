import mongoose from 'mongoose';
import Party from '../models/Party.js';
import asyncHandler from '../middlewares/asyncHandler.js';
import { PAKISTAN_CITIES, cityMatchKey } from '../utils/cities.js';
import { adapterFor } from '../utils/couriers/index.js';
import { courierCities, clearCityCache } from '../utils/couriers/booking.js';
import { PARTY_TYPES } from '../utils/constants.js';
import logger from '../utils/logger.js';

/**
 * The business's connected couriers, as `{ provider, partyId }`. Only someone assigned to the business
 * (or a full-access user) gets them: for anyone else the answer is the plain list, never a 404 — a list of
 * Pakistani cities is not a secret, which of this business's couriers serve them is.
 */
const connectedCouriers = async (user, business) => {
  if (!business || !mongoose.isValidObjectId(business)) return [];
  const mine = (user.assignedBusinesses ?? []).map(String).includes(String(business));
  if (!user.role?.fullAccess && !mine) return [];
  const parties = await Party.find({
    business,
    type: PARTY_TYPES.COURIER,
    'integration.provider': { $exists: true },
    'integration.isEnabled': true
  }).select('integration.provider');
  return parties.map(p => ({ provider: p.integration.provider, partyId: p._id }));
};

/** What each connected courier serves, or `null` for one that could not be asked (never blocks the list). */
const servedBy = async (couriers, { fresh = false } = {}) => {
  const out = [];
  for (const { provider, partyId } of couriers) {
    try {
      const { api } = await adapterFor(partyId);
      out.push({ provider, cities: await courierCities(partyId, api, { fresh }) });
    } catch (err) {
      logger.warn({ provider, err: err.message }, 'courier city list unavailable');
      out.push({ provider, cities: null });
    }
  }
  return out;
};

/**
 * @desc   Cities for the search box: our standard list merged with each connected courier's own list
 *         (spelling: the courier's wins, so what is stored is what it accepts), each marked with whether
 *         each connected courier serves it. Matches anywhere in the name, ignoring spaces and hyphens;
 *         five at a time. A courier that cannot be asked simply shows no tick — it never blocks the list.
 * @route  GET /api/v1/cities?business=&search=&page=&limit=  (signed in)
 */
export const searchCities = asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 5, 1), 50);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const needle = cityMatchKey(req.query.search);

  const couriers = await servedBy(await connectedCouriers(req.user, req.query.business));

  // One entry per place, whichever list it came from; the courier's spelling replaces ours.
  const merged = new Map(PAKISTAN_CITIES.map(name => [cityMatchKey(name), name]));
  for (const { cities } of couriers) {
    for (const [key, name] of cities?.byKey ?? []) merged.set(key, name);
  }

  const rows = [...merged.entries()]
    .filter(([key]) => !needle || key.includes(needle))
    // Names that START with what was typed come first, then the rest alphabetically.
    .sort(([ka, a], [kb, b]) => {
      const starts = Number(kb.startsWith(needle)) - Number(ka.startsWith(needle));
      return starts || a.localeCompare(b);
    });

  const data = rows.slice((page - 1) * limit, page * limit).map(([key, name]) => {
    const served = {};
    for (const { provider, cities } of couriers) {
      if (cities) served[provider] = cities.byKey.has(key);
    }
    return { name, served };
  });

  res.status(200).json({
    success: true,
    count: data.length,
    total: rows.length,
    pagination: page * limit < rows.length ? { next: { page: page + 1, limit } } : {},
    data
  });
});

/** A person can ask again at most this often per courier — it is a call to the courier's service. */
const REFRESH_EVERY_MS = 60_000;
const lastRefresh = new Map();

/**
 * @desc   Forget the cached city lists of this business's couriers so the next search asks again — for
 *         when the courier has just opened a city.
 * @route  POST /api/v1/cities/refresh  { business }  (orders:create — scoped)
 */
export const refreshCities = asyncHandler(async (req, res) => {
  const couriers = await connectedCouriers(req.user, req.body.business);
  let refreshed = 0;
  for (const { partyId } of couriers) {
    const key = String(partyId);
    if (Date.now() - (lastRefresh.get(key) ?? 0) < REFRESH_EVERY_MS) continue;
    lastRefresh.set(key, Date.now());
    clearCityCache(partyId);
    refreshed += 1;
  }
  res.status(200).json({ success: true, data: { refreshed } });
});
