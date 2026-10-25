/**
 * A courier's service said no, or could not be reached. The message is written for the shop person
 * (the controller shows it as-is, with a 502 so the screen does not mistake it for their own
 * mistake or for a signed-out session). `retryable` is for the caller's own back-off.
 */
export class CourierError extends Error {
  constructor(message, { code, retryable = false, cause } = {}) {
    super(message, { cause });
    this.name = 'CourierError';
    this.code = code;
    this.retryable = retryable;
    this.statusCode = 502;
  }
}
