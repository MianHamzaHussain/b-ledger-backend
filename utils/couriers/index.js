import Party from '../../models/Party.js';
import ErrorResponse from '../errorResponse.js';
import { decryptSecret } from '../secretBox.js';
import { createPostex } from './postex.js';

/**
 * The courier services the app can talk to. `courierDeps.fetchImpl` is the only door to the network:
 * tests replace it, so nothing in the suite can reach a real courier or book a real parcel.
 */
export const courierDeps = { fetchImpl: (...args) => fetch(...args) };

const PROVIDERS = { postex: createPostex };

/**
 * The adapter for a courier party that is connected AND switched on (`requireEnabled: false` is for
 * the Test button, which must work before booking is turned on), or a 400 saying why not. Re-reads the party
 * with its saved key (hidden from every normal read), decrypts it for this one call, and hands the
 * key only to the adapter.
 */
export const adapterFor = async (partyId, { requireEnabled = true } = {}) => {
  const party = await Party.findById(partyId).select('+integration.tokenEnc');
  const link = party?.integration;
  if (!link?.provider || !link.tokenEnc || (requireEnabled && !link.isEnabled)) {
    throw new ErrorResponse('This courier is not connected to its service', 400);
  }
  const make = PROVIDERS[link.provider];
  if (!make) throw new ErrorResponse(`${link.provider} is not supported yet`, 400);
  return {
    provider: link.provider,
    party,
    api: make({ token: decryptSecret(link.tokenEnc), fetchImpl: courierDeps.fetchImpl })
  };
};
