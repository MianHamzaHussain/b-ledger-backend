import Party from '../../models/Party.js';
import ErrorResponse from '../errorResponse.js';
import { decryptSecret } from '../secretBox.js';
import { createPostex } from './postex.js';
import { createTcs } from './tcs.js';

/**
 * The courier services the app can talk to. `courierDeps.fetchImpl` is the only door to the network:
 * tests replace it, so nothing in the suite can reach a real courier or book a real parcel.
 */
export const courierDeps = { fetchImpl: (...args) => fetch(...args) };

const PROVIDERS = { postex: createPostex, tcs: createTcs };

/** How a courier is named to a person — the one place that knows. */
export const PROVIDER_NAMES = { postex: 'PostEx', tcs: 'TCS' };
export const providerName = provider => PROVIDER_NAMES[provider] ?? 'This courier';

/**
 * What the "Add courier" form shows for each service — the one list the form is built from, so a new courier is
 * one entry here (plus its adapter), not a new screen. `fields` are what a person types; secrets are never read back.
 */
export const PROVIDER_FORMS = {
  postex: {
    label: 'PostEx',
    fields: [{ name: 'token', label: 'PostEx API key', secret: true }],
    note: 'PostEx → Merchant portal → Settings → API key.'
  },
  tcs: {
    label: 'TCS',
    fields: [
      { name: 'clientId', label: 'Client id' },
      { name: 'clientSecret', label: 'Client secret', secret: true },
      { name: 'username', label: 'Username' },
      { name: 'password', label: 'Password', secret: true },
      { name: 'accountNumber', label: 'TCS account number' }
    ],
    note: 'TCS has not been tried against the live service yet — check the first parcels by hand.'
  }
};

/**
 * Point the adapter at a stand-in service (a local fake, for demos and recordings) — never in
 * production, where a changed address would send real keys somewhere else.
 */
const testBase = provider => {
  if (process.env.NODE_ENV === 'production') return {};
  if (provider === 'tcs' && process.env.TCS_BASE_URL) return { base: process.env.TCS_BASE_URL };
  if (provider === 'postex' && process.env.POSTEX_BASE_URL) {
    return { base: process.env.POSTEX_BASE_URL, adviceBase: process.env.POSTEX_BASE_URL };
  }
  return {};
};

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
    api: make({
      token: decryptSecret(link.tokenEnc),
      // TCS also needs the shop's account number and (optionally) a service code; PostEx ignores both.
      account: link.accountNumber,
      service: link.serviceCode,
      fetchImpl: courierDeps.fetchImpl,
      ...testBase(link.provider)
    })
  };
};
