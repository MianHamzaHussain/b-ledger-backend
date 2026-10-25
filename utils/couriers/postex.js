import { CourierError } from './courierError.js';

/**
 * PostEx Merchant API (guide v4.1.9). Every call takes the merchant's key in a `token` header.
 *
 * This file only speaks to PostEx: it knows the URLs, the parameter names and how PostEx words an
 * error, and turns a failure into a `CourierError` whose message is something a shop person can
 * act on. It never touches orders or money — that is for the callers — and `fetch` is injected so
 * tests never reach the real service (and a test can never book a real parcel).
 */
const BASE = 'https://api.postex.pk/services/integration/api';
// The guide spells this one group of endpoints "service" (singular); kept as documented.
const BASE_ADVICE = 'https://api.postex.pk/service/integration/api';
const TIMEOUT_MS = 15_000;

export const createPostex = ({
  token,
  fetchImpl = fetch,
  base = BASE,
  adviceBase = BASE_ADVICE
}) => {
  if (!token) throw new CourierError('There is no PostEx key saved for this courier');

  const send = async (method, url, { query, body, binary = false } = {}) => {
    const target = new URL(url);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== '') target.searchParams.set(k, String(v));
    }
    let response;
    try {
      response = await fetchImpl(target, {
        method,
        headers: {
          token,
          Accept: binary ? 'application/pdf' : 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch (err) {
      throw new CourierError('PostEx could not be reached. Try again in a moment.', {
        retryable: true,
        cause: err
      });
    }

    if (response.status === 401 || response.status === 403) {
      throw new CourierError('PostEx did not accept the saved key. Check it with PostEx.', {
        code: response.status
      });
    }
    if (binary && response.ok) return Buffer.from(await response.arrayBuffer());

    const json = await response.json().catch(() => ({}));
    const statusCode = Number(json.statusCode ?? response.status);
    if (!response.ok || statusCode >= 400) {
      throw new CourierError(plainMessage(json.statusMessage, statusCode), {
        code: statusCode,
        retryable: statusCode >= 500
      });
    }
    return json;
  };

  /** GETs are safe to repeat once on a network blip; a create is never repeated blindly. */
  const get = async (url, options) => {
    try {
      return await send('GET', url, options);
    } catch (err) {
      if (err instanceof CourierError && err.retryable) return send('GET', url, options);
      throw err;
    }
  };

  return {
    /** Cities PostEx delivers to (`Delivery`) or collects from (`Pickup`). */
    async cities(type = 'Delivery') {
      const json = await get(`${base}/order/v2/get-operational-city`, {
        query: { operationalCityType: type }
      });
      return (json.dist ?? []).map(c => c.operationalCityName);
    },

    /** The merchant's registered pickup addresses. */
    async addresses() {
      const json = await get(`${base}/order/v1/get-merchant-address`);
      return (json.dist ?? []).map(a => ({
        addressCode: a.addressCode,
        address: a.address,
        cityName: a.cityName,
        contactPersonName: a.contactPersonName
      }));
    },

    /** Book a parcel. Returns PostEx's tracking number (status `UnBooked` until picked up). */
    async createOrder(order) {
      const json = await send('POST', `${base}/order/v3/create-order`, { body: order });
      const created = json.dist ?? {};
      if (!created.trackingNumber) {
        throw new CourierError('PostEx accepted the parcel but sent no tracking number');
      }
      return {
        trackingNumber: created.trackingNumber,
        orderStatus: created.orderStatus,
        orderDate: created.orderDate
      };
    },

    /** Cancel a parcel that PostEx has not picked up yet. */
    async cancel(trackingNumber) {
      await send('PUT', `${base}/order/v1/cancel-order`, { body: { trackingNumber } });
    },

    /** One parcel's current state and journey. */
    async track(trackingNumber) {
      const json = await get(`${base}/order/v1/track-order/${encodeURIComponent(trackingNumber)}`);
      return normalizeTracking(json.dist);
    },

    /** Several parcels at once (comma-separated, as the guide says). */
    async trackBulk(trackingNumbers) {
      const json = await get(`${base}/order/v1/track-bulk-order`, {
        query: { trackingNumber: trackingNumbers.join(',') }
      });
      return (json.dist ?? []).map(row => ({
        trackingNumber: row.trackingNumber,
        found: !/not\s*found|invalid/i.test(row.message ?? ''),
        ...normalizeTracking(row.trackingResponse)
      }));
    },

    /** Airway bill PDF for up to 10 parcels. */
    async airwayBill(trackingNumbers) {
      return get(`${base}/order/v1/get-invoice`, {
        query: { trackingNumbers: trackingNumbers.slice(0, 10).join(',') },
        binary: true
      });
    },

    /** Load sheet PDF for a batch handed to the rider. */
    async loadSheet(trackingNumbers, pickupAddress) {
      return send('POST', `${base}/order/v2/generate-load-sheet`, {
        body: { trackingNumbers, ...(pickupAddress ? { pickupAddress } : {}) },
        binary: true
      });
    },

    /** Parcels created on PostEx but not yet picked up, newest data first. */
    async unbooked({ startDate, endDate, cityName }) {
      const json = await get(`${base}/order/v2/get-unbooked-orders`, {
        query: { startDate, endDate, cityName }
      });
      return (json.dist ?? []).map(normalizeTracking);
    },

    /** Has PostEx paid this parcel's COD out? */
    async paymentStatus(trackingNumber) {
      const json = await get(
        `${base}/order/v1/payment-status/${encodeURIComponent(trackingNumber)}`
      );
      const d = json.dist ?? {};
      return { settled: Boolean(d.settle), settlementDate: d.settlementDate || null };
    },

    /** After a failed try: 1 = return it, 2 = try again. */
    async shipperAdvice({ trackingNumber, statusId, remarks }) {
      await send('PUT', `${adviceBase}/order/v2/save-shipper-advice`, {
        body: { trackingNumber, statusId, remarks }
      });
    }
  };
};

/** The few fields the app uses, from PostEx's long tracking record. */
const normalizeTracking = t => {
  if (!t) return {};
  return {
    trackingNumber: t.trackingNumber,
    orderRefNumber: t.orderRefNumber,
    customerPhone: t.customerPhone,
    cityName: t.cityName,
    invoicePayment: toNumber(t.invoicePayment),
    status: t.transactionStatus ?? '',
    // What PostEx charged to deliver, and to bring it back.
    fee: toNumber(t.transactionFee),
    tax: toNumber(t.transactionTax),
    reversalFee: toNumber(t.reversalFee),
    reversalTax: toNumber(t.reversalTax),
    history: (t.transactionStatusHistory ?? []).map(h => ({
      code: h.transactionStatusMessageCode,
      message: h.transactionStatusMessage
    }))
  };
};

const toNumber = v => (v === undefined || v === null || v === '' ? 0 : Number(v) || 0);

/** PostEx's own wording is kept when it is readable; the code only picks a fallback. */
const plainMessage = (statusMessage, code) => {
  if (statusMessage && !/^successfully/i.test(statusMessage))
    return `PostEx says: ${statusMessage}`;
  if (code === 404) return 'PostEx could not find that parcel';
  if (code >= 500) return 'PostEx is having trouble right now. Try again later.';
  return 'PostEx did not accept the request';
};
