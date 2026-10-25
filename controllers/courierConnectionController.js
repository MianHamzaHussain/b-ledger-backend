import Party from '../models/Party.js';
import asyncHandler from '../middlewares/asyncHandler.js';
import ErrorResponse from '../utils/errorResponse.js';
import logger from '../utils/logger.js';
import { encryptSecret } from '../utils/secretBox.js';
import { adapterFor } from '../utils/couriers/index.js';
import { PARTY_TYPES } from '../utils/constants.js';

/**
 * A courier's connection to its own service (PostEx today): the key, which pickup address to book
 * from, and whether booking is on. Admin only, and the key only ever goes IN — no response, log or
 * screen shows it, only whether one is saved.
 *
 * @route  GET    /api/v1/parties/:id/connection
 * @route  PUT    /api/v1/parties/:id/connection
 * @route  POST   /api/v1/parties/:id/connection/test
 * @route  DELETE /api/v1/parties/:id/connection
 */
const view = party => {
  const link = party.integration ?? {};
  return {
    provider: link.provider ?? null,
    isEnabled: Boolean(link.isEnabled),
    hasToken: Boolean(link.hasToken),
    pickupAddressCode: link.pickupAddressCode ?? null,
    pickupAddressLabel: link.pickupAddressLabel ?? null,
    lastCheckedAt: link.lastCheckedAt ?? null,
    lastError: link.lastError ?? null
  };
};

const ensureCourier = party => {
  if (party.type !== PARTY_TYPES.COURIER) {
    throw new ErrorResponse('Only a courier can be connected to a courier service', 400);
  }
};

export const getConnection = asyncHandler(async (req, res) => {
  ensureCourier(req.resource);
  res.status(200).json({ success: true, data: view(req.resource) });
});

export const saveConnection = asyncHandler(async (req, res) => {
  const party = req.resource;
  ensureCourier(party);
  const { provider, token, pickupAddressCode, pickupAddressLabel, isEnabled } = req.body;

  const link = party.integration ?? {};
  const next = { ...(link.toObject?.() ?? link) };
  if (provider) next.provider = provider;
  if (token) {
    next.tokenEnc = encryptSecret(token);
    next.hasToken = true;
    next.lastError = undefined;
  }
  if (pickupAddressCode !== undefined) next.pickupAddressCode = pickupAddressCode || undefined;
  if (pickupAddressLabel !== undefined) next.pickupAddressLabel = pickupAddressLabel || undefined;
  if (isEnabled !== undefined) {
    if (isEnabled && !(next.hasToken ?? link.hasToken)) {
      throw new ErrorResponse('Save the key before turning booking on', 400);
    }
    next.isEnabled = isEnabled;
  }

  await Party.updateOne(
    { _id: party._id },
    { $set: { integration: next, updatedBy: req.user.id } }
  );
  logger.info(
    { userId: req.user.id, party: String(party._id), provider: next.provider },
    'courier connection saved'
  );

  const fresh = await Party.findById(party._id);
  res.status(200).json({ success: true, data: view(fresh) });
});

/** Ask the courier something harmless with the saved key: its pickup addresses. */
export const testConnection = asyncHandler(async (req, res, next) => {
  ensureCourier(req.resource);
  const { api, party } = await adapterFor(req.resource._id, { requireEnabled: false });
  try {
    const addresses = await api.addresses();
    await Party.updateOne(
      { _id: party._id },
      { $set: { 'integration.lastCheckedAt': new Date() }, $unset: { 'integration.lastError': 1 } }
    );
    res.status(200).json({ success: true, data: { addresses } });
  } catch (err) {
    await Party.updateOne(
      { _id: party._id },
      { $set: { 'integration.lastCheckedAt': new Date(), 'integration.lastError': err.message } }
    );
    next(err);
  }
});

export const removeConnection = asyncHandler(async (req, res) => {
  ensureCourier(req.resource);
  await Party.updateOne(
    { _id: req.resource._id },
    { $unset: { integration: 1 }, $set: { updatedBy: req.user.id } }
  );
  logger.info(
    { userId: req.user.id, party: String(req.resource._id) },
    'courier connection removed'
  );
  res.status(200).json({ success: true, data: view({}) });
});
