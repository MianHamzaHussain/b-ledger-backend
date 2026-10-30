import Party from '../models/Party.js';
import asyncHandler from '../middlewares/asyncHandler.js';
import ErrorResponse from '../utils/errorResponse.js';
import logger from '../utils/logger.js';
import { encryptSecret } from '../utils/secretBox.js';
import { adapterFor } from '../utils/couriers/index.js';
import { PARTY_TYPES } from '../utils/constants.js';

/**
 * A courier's connection to its own service (PostEx and TCS): the key, which pickup address to book
 * from, and whether booking is on. Admin only, and the key only ever goes IN — no response, log or
 * screen shows it, only whether one is saved.
 *
 * @route  GET    /api/v1/parties/:id/connection
 * @route  PUT    /api/v1/parties/:id/connection
 * @route  POST   /api/v1/parties/:id/connection/test
 * @route  DELETE /api/v1/parties/:id/connection
 */
export const view = party => {
  const link = party.integration ?? {};
  return {
    provider: link.provider ?? null,
    isEnabled: Boolean(link.isEnabled),
    hasToken: Boolean(link.hasToken),
    accountNumber: link.accountNumber ?? null,
    serviceCode: link.serviceCode ?? null,
    pickupAddressCode: link.pickupAddressCode ?? null,
    pickupAddressLabel: link.pickupAddressLabel ?? null,
    lastCheckedAt: link.lastCheckedAt ?? null,
    lastError: link.lastError ?? null,
    autoConfirm: Boolean(link.autoConfirm),
    recordPayments: Boolean(link.recordPayments),
    adoptTyped: link.adoptTyped !== false
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
  const { provider, pickupAddressCode, pickupAddressLabel, isEnabled, credentials } = req.body;
  const { accountNumber, serviceCode } = req.body;
  let { autoConfirm } = req.body;
  const { recordPayments, adoptTyped } = req.body;
  const chosen = provider ?? party.integration?.provider;
  // PostEx has one key; TCS signs in with four values, kept together as one encrypted secret.
  if (credentials && chosen !== 'tcs') {
    throw new ErrorResponse(
      'Only TCS signs in with a client id, secret, username and password',
      400
    );
  }
  if (req.body.token && chosen === 'tcs') {
    throw new ErrorResponse('TCS signs in with a client id, secret, username and password', 400);
  }
  const token = credentials ? JSON.stringify(credentials) : req.body.token;

  // Field by field, never the whole `integration` object: the saved key is hidden from this read
  // (select:false), so rewriting the object would silently delete it.
  const set = { updatedBy: req.user.id };
  const unset = {};
  if (provider) set['integration.provider'] = provider;
  // A connection made from now on starts with automatic delivered / returned ON (two matching checks);
  // an existing one is not changed silently — an admin turns it on with one click.
  // TCS is new and not yet proven against the live service: it starts OFF and a person turns it on.
  if (provider && !party.integration?.provider && autoConfirm === undefined) {
    autoConfirm = provider !== 'tcs';
  }
  if (autoConfirm !== undefined) {
    set['integration.autoConfirm'] = autoConfirm;
    if (autoConfirm) set['integration.autoConfirmBy'] = req.user.id;
    else unset['integration.autoConfirmBy'] = 1;
  }
  if (recordPayments && chosen === 'tcs') {
    throw new ErrorResponse(
      'TCS payments are entered from its invoice, not recorded automatically',
      400
    );
  }
  if (recordPayments !== undefined) {
    if (recordPayments && !token && !party.integration?.hasToken) {
      throw new ErrorResponse('Save the key before recording its payments', 400);
    }
    set['integration.recordPayments'] = recordPayments;
    if (recordPayments) set['integration.recordPaymentsBy'] = req.user.id;
    else unset['integration.recordPaymentsBy'] = 1;
  }
  if (adoptTyped !== undefined) set['integration.adoptTyped'] = adoptTyped;
  if (token) {
    set['integration.tokenEnc'] = encryptSecret(token);
    set['integration.hasToken'] = true;
    unset['integration.lastError'] = 1;
  }
  if (accountNumber !== undefined) {
    if (accountNumber) set['integration.accountNumber'] = accountNumber;
    else unset['integration.accountNumber'] = 1;
  }
  if (serviceCode !== undefined) {
    if (serviceCode) set['integration.serviceCode'] = serviceCode;
    else unset['integration.serviceCode'] = 1;
  }
  if (pickupAddressCode !== undefined) {
    if (pickupAddressCode) set['integration.pickupAddressCode'] = pickupAddressCode;
    else unset['integration.pickupAddressCode'] = 1;
  }
  if (pickupAddressLabel !== undefined) {
    if (pickupAddressLabel) set['integration.pickupAddressLabel'] = pickupAddressLabel;
    else unset['integration.pickupAddressLabel'] = 1;
  }
  if (isEnabled !== undefined) {
    if (isEnabled && !token && !party.integration?.hasToken) {
      throw new ErrorResponse('Save the key before turning booking on', 400);
    }
    set['integration.isEnabled'] = isEnabled;
  }

  await Party.updateOne(
    { _id: party._id },
    { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) }
  );
  logger.info(
    {
      userId: req.user.id,
      party: String(party._id),
      provider: provider ?? party.integration?.provider
    },
    'courier connection saved'
  );

  res.status(200).json({ success: true, data: view(await Party.findById(party._id)) });
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
