import crypto from 'node:crypto';
import ErrorResponse from './errorResponse.js';

/**
 * Encrypt a small secret (a courier's API key) before it is saved, and read it back only on the
 * server when a call to the courier needs it.
 *
 * AES-256-GCM: the saved text is `v1:<iv>:<tag>:<cipher>` (base64), so a tampered value fails to
 * open rather than decrypting to garbage. The key is `COURIER_SECRET_KEY` (64 hex characters) in
 * the server's environment — deliberately NOT in the database, so a copy of the database alone
 * (a backup, say) does not reveal anyone's key. Without it, connecting a courier is refused with a
 * clear message instead of storing the key in the clear.
 */
const keyBytes = () => {
  const hex = process.env.COURIER_SECRET_KEY ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new ErrorResponse(
      'Courier connections are not set up on this server yet (COURIER_SECRET_KEY is missing)',
      503
    );
  }
  return Buffer.from(hex, 'hex');
};

export const encryptSecret = plain => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes(), iv);
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), body]
    .map(p => (Buffer.isBuffer(p) ? p.toString('base64') : p))
    .join(':');
};

export const decryptSecret = saved => {
  const [version, iv, tag, body] = String(saved ?? '').split(':');
  if (version !== 'v1' || !iv || !tag || !body) {
    throw new ErrorResponse('The saved courier key is unreadable — enter it again', 500);
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString(
      'utf8'
    );
  } catch (err) {
    if (err instanceof ErrorResponse) throw err;
    throw new ErrorResponse('The saved courier key can not be opened — enter it again', 500);
  }
};
