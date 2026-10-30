import Party from '../../models/Party.js';
import Account from '../../models/Account.js';
import { PARTY_TYPES } from '../constants.js';
import { encryptSecret } from '../secretBox.js';
import { courierWalletFor } from '../moneyAccounts.js';
import logger from '../logger.js';
import { adapterFor } from './index.js';

/**
 * Add a courier in ONE step: the Khata party, the encrypted key, a test of that key, the pickup address, the
 * automatic steps and the courier's wallet account. If anything after the party is made fails, everything made
 * so far is removed, so a wrong key never leaves a half-made courier behind to be tidied up in Khata.
 *
 * What it turns on, and what it deliberately does not:
 *  - booking on, once there is a pickup address (the only one, or the person picks);
 *  - automatic delivered / returned on (two matching checks), except TCS, which is untried and starts off;
 *  - following typed-in tracking numbers on (it is on unless switched off, so nothing is written);
 *  - the wallet account made (PostEx only), but "record payments" stays OFF: it posts real money from an amount
 *    that is calculated, so a person turns it on after checking the first batch against PostEx's own statement.
 */
export const createCourier = async ({ business, body, user }) => {
  const { name, phone, note, provider, token, credentials, accountNumber, serviceCode } = body;
  const party = await Party.create({
    business,
    name,
    type: PARTY_TYPES.COURIER,
    phone,
    note,
    createdBy: user.id
  });
  if (!provider) return { party, addresses: [], needsPickup: false, walletMade: false };

  let walletMade = false;
  try {
    const secret = credentials ? JSON.stringify(credentials) : token;
    const set = {
      'integration.provider': provider,
      'integration.tokenEnc': encryptSecret(secret),
      'integration.hasToken': true,
      'integration.autoConfirm': provider !== 'tcs',
      updatedBy: user.id
    };
    if (provider !== 'tcs') set['integration.autoConfirmBy'] = user.id;
    if (accountNumber) set['integration.accountNumber'] = accountNumber;
    if (serviceCode) set['integration.serviceCode'] = serviceCode;
    await Party.updateOne({ _id: party._id }, { $set: set });

    // Asking for the pickup addresses is the test: it needs a working key (and, for TCS, the account number).
    const { api } = await adapterFor(party._id, { requireEnabled: false });
    const addresses = await api.addresses();
    const ready = { 'integration.lastCheckedAt': new Date() };
    const single = addresses.length === 1 ? addresses[0] : null;
    if (single) {
      ready['integration.pickupAddressCode'] = single.addressCode;
      ready['integration.pickupAddressLabel'] = [single.address, single.cityName]
        .filter(Boolean)
        .join(', ');
      ready['integration.isEnabled'] = true;
    }
    await Party.updateOne({ _id: party._id }, { $set: ready });

    if (provider === 'postex') {
      await courierWalletFor(business, party, user.id);
      walletMade = true;
    }
    return {
      party: await Party.findById(party._id),
      addresses,
      needsPickup: !single,
      walletMade
    };
  } catch (err) {
    await Account.deleteMany({ business, courier: party._id }).catch(() => {});
    await Party.deleteOne({ _id: party._id }).catch(() => {});
    logger.warn({ provider, err: err.message }, 'courier not added: setup failed and was undone');
    throw err;
  }
};
