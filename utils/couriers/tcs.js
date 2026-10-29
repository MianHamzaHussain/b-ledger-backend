import { PDFDocument } from 'pdf-lib';
import { CourierError } from './courierError.js';

/**
 * TCS E-COM API (API User Guide v1.0). This file only speaks to TCS: URLs, parameter names, the
 * two-step sign-in and how TCS words an error. It never touches orders or money, and `fetch` is
 * injected so no test can reach the real service or book a real parcel.
 *
 * **Not yet proven against the live service.** It is built from the guide; TCS gives no public test
 * credentials, so the first run against their UAT environment (devconnect) is where any difference
 * between the guide and the service shows up. The pieces that most need that check are marked UAT.
 *
 * Sign-in has two steps, both documented: (1) client id + secret → a bearer token, (2) username +
 * password → an `accesstoken` that is ALSO written into every request body. Both are remembered
 * until they expire. GET calls send their parameters in the query string (a GET carries no body);
 * a secret is never put in an error message or a log line — messages are written here, by hand.
 */
const BASE = 'https://ociconnect.tcscourier.com';
const TIMEOUT_MS = 20_000;
const MIN_WEIGHT_KG = 0.5;
const MAX_COD = 250_000;
/** TCS's documented example service code ("O"); a connection can choose another. */
const DEFAULT_SERVICE = 'O';
const REFRESH_EARLY_MS = 60_000;

/** Signed-in tokens by service + client, so a status check of 50 parcels signs in once. */
const sessions = new Map();
export const clearTcsSessions = () => sessions.clear();

const text = (v, max) =>
  String(v ?? '')
    .trim()
    .slice(0, max);

/** TCS wants a first, a middle and a last name; a shop has one "customer name". */
export const splitName = full => {
  const parts = text(full, 150).split(/\s+/).filter(Boolean);
  const first = parts[0] ?? '';
  const rest = parts.slice(1);
  const long = s => (s.length >= 3 ? s : '');
  return {
    firstname: long(first) || text(full, 50),
    middlename: long(rest[0] ?? '') || long(first) || text(full, 50),
    lastname: long(rest.slice(1).join(' '))
  };
};

/** An address spread over TCS's three 120-character lines. */
export const addressLines = address => {
  const a = text(address, 360);
  return { address1: a.slice(0, 120), address2: a.slice(120, 240), address3: a.slice(240, 360) };
};

const parseCredentials = raw => {
  try {
    const c = JSON.parse(raw);
    if (c.clientId && c.clientSecret && c.username && c.password) return c;
  } catch {
    /* falls through */
  }
  throw new CourierError('The TCS sign-in details saved for this courier are incomplete');
};

export const createTcs = ({ token, account, fetchImpl = fetch, base = BASE, service }) => {
  if (!token) throw new CourierError('There are no TCS sign-in details saved for this courier');
  const credentials = parseCredentials(token);
  const sessionKey = `${base}|${credentials.clientId}`;

  const raw = async (method, url, { query, body, headers = {}, binary = false } = {}) => {
    const target = new URL(url);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== '') target.searchParams.set(k, String(v));
    }
    let response;
    try {
      response = await fetchImpl(target, {
        method,
        headers: {
          Accept: binary ? 'application/pdf' : 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch (err) {
      throw new CourierError('TCS could not be reached. Try again in a moment.', {
        retryable: true,
        cause: err
      });
    }
    return response;
  };

  /** Both sign-in steps. UAT: the guide shows the credentials as a GET "body"; they go in the query. */
  const signIn = async () => {
    const first = await raw('GET', `${base}/auth/api/auth`, {
      query: { clientid: credentials.clientId, clientsecret: credentials.clientSecret }
    });
    const firstJson = await first.json().catch(() => ({}));
    const bearer = firstJson?.result?.accessToken;
    if (!first.ok || !bearer) {
      throw new CourierError('TCS did not accept the client id and secret. Check them with TCS.', {
        code: first.status
      });
    }
    const second = await raw('GET', `${base}/ecom/api/authentication/token`, {
      query: { username: credentials.username, password: credentials.password },
      headers: { Authorization: `Bearer ${bearer}` }
    });
    const secondJson = await second.json().catch(() => ({}));
    if (!second.ok || !secondJson.accesstoken) {
      throw new CourierError('TCS did not accept the username and password. Check them with TCS.', {
        code: second.status
      });
    }
    const expiry = Date.parse(secondJson.expiry ?? firstJson.result?.expiry ?? '');
    const session = {
      bearer,
      accesstoken: secondJson.accesstoken,
      expiresAt: Number.isFinite(expiry) ? expiry : Date.now() + 30 * 60_000
    };
    sessions.set(sessionKey, session);
    return session;
  };

  const session = async () => {
    const hit = sessions.get(sessionKey);
    return hit && hit.expiresAt - REFRESH_EARLY_MS > Date.now() ? hit : signIn();
  };

  /** One authorised call. A rejected sign-in is retried once with a fresh one. */
  const send = async (method, url, { query, body, binary = false } = {}, retried = false) => {
    const s = await session();
    const response = await raw(method, url, {
      query: method === 'GET' ? { ...query, accesstoken: s.accesstoken } : query,
      body: body ? { ...body, accesstoken: s.accesstoken } : undefined,
      headers: { Authorization: `Bearer ${s.bearer}` },
      binary
    });
    if (response.status === 401 || response.status === 403) {
      sessions.delete(sessionKey);
      if (!retried) return send(method, url, { query, body, binary }, true);
      throw new CourierError('TCS did not accept the saved sign-in. Check it with TCS.', {
        code: response.status
      });
    }
    const type = response.headers?.get?.('content-type') ?? '';
    if (binary && response.ok && /pdf|octet-stream/i.test(type)) {
      return Buffer.from(await response.arrayBuffer());
    }
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new CourierError(plainMessage(json), {
        code: response.status,
        retryable: response.status >= 500
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

  const costCenters = async () => {
    const json = await get(`${base}/ecom/inquiry/costcenterinquiry`, {
      query: { customerno: account }
    });
    return (json.detail ?? []).map(c => ({
      code: c.costcentercode,
      city: c.costcentercity,
      name: c.costcentername,
      phone: c.phoneno,
      address: text(c.pickupaddress, 120)
    }));
  };

  return {
    /** Cities TCS delivers to in Pakistan, as the names TCS spells them. */
    async cities() {
      const json = await get(`${base}/ecom/api/setup/citylistbycountry`, {
        query: { countrycode: 'PK' }
      });
      return (json.data ?? []).map(c => c.cityname).filter(Boolean);
    },

    /** The merchant's cost centers — TCS's word for a pickup point; the code is what a booking names. */
    async addresses() {
      if (!account) {
        throw new CourierError('Add the TCS account number in this courier’s settings first');
      }
      return (await costCenters()).map(c => ({
        addressCode: c.code,
        address: c.address,
        cityName: c.city,
        contactPersonName: c.name
      }));
    },

    /** Book a parcel. Returns TCS's consignment number. */
    async createOrder(parcel) {
      if (!account) {
        throw new CourierError('Add the TCS account number in this courier’s settings first');
      }
      const cod = Math.round(Number(parcel.invoicePayment) || 0);
      if (cod > MAX_COD) {
        throw new CourierError(
          `TCS takes at most Rs ${MAX_COD.toLocaleString('en-PK')} cash on delivery per parcel`
        );
      }
      const center = (await costCenters()).find(c => c.code === parcel.pickupAddressCode);
      if (!center) {
        throw new CourierError('That pickup point is not on the TCS account. Choose it again.');
      }
      if (!/^\d{11}$/.test(String(center.phone ?? ''))) {
        throw new CourierError(
          'The TCS cost center has no 11-digit phone number. Ask TCS to add one.'
        );
      }
      const pieces = Math.max(1, Number(parcel.items) || 1);
      const contents = text(parcel.orderDetail, 50);
      const body = {
        shipperinfo: {
          tcsaccount: text(account, 12),
          shippername: text(center.name, 50),
          ...addressLines(center.address),
          countrycode: 'PK',
          countryname: 'Pakistan',
          cityname: text(center.city, 50),
          mobile: center.phone
        },
        consigneeinfo: {
          ...splitName(parcel.customerName),
          ...addressLines(parcel.deliveryAddress),
          countrycode: 'PK',
          countryname: 'Pakistan',
          cityname: text(parcel.cityName, 50),
          mobile: parcel.customerPhone
        },
        shipmentinfo: {
          costcentercode: center.code,
          referenceno: text(parcel.orderRefNumber, 50),
          contentdesc: contents,
          servicecode: service || DEFAULT_SERVICE,
          currency: 'PKR',
          codamount: cod,
          weightinkg: MIN_WEIGHT_KG,
          pieces,
          fragile: false,
          remarks: text(parcel.transactionNotes, 500),
          skus: [
            {
              description: contents || 'Order',
              quantity: pieces,
              weight: MIN_WEIGHT_KG,
              unitprice: Math.max(1, Math.round(cod / pieces))
            }
          ]
        }
      };
      const json = await send('POST', `${base}/ecom/api/booking/create`, { body });
      const trackingNumber = json.consignmentNo ?? json.consignmentno;
      if (!trackingNumber) {
        throw new CourierError('TCS accepted the parcel but sent no consignment number');
      }
      return { trackingNumber: String(trackingNumber), orderStatus: 'Booked' };
    },

    /** Cancel a booking TCS has not collected yet. */
    async cancel(trackingNumber) {
      const json = await send('POST', `${base}/ecom/api/booking/cancel`, {
        body: { consignmentNumber: trackingNumber }
      });
      if (!/success/i.test(json.message ?? '')) throw new CourierError(plainMessage(json));
    },

    /** One parcel's current state and journey. */
    async track(trackingNumber) {
      const json = await get(`${base}/tracking/api/Tracking/GetDynamicTrackDetail`, {
        query: { consignee: trackingNumber }
      });
      return normalizeTracking(json, trackingNumber);
    },

    /** Several parcels: TCS answers one consignment per call, so a few at a time. */
    async trackBulk(trackingNumbers) {
      const out = [];
      for (let i = 0; i < trackingNumbers.length; i += 5) {
        const group = trackingNumbers.slice(i, i + 5);
        out.push(
          ...(await Promise.all(
            group.map(async cn => {
              try {
                const t = await this.track(cn);
                return { found: t.found, ...t };
              } catch {
                return { trackingNumber: cn, found: false };
              }
            })
          ))
        );
      }
      return out;
    },

    /** Airway bills (TCS's "CN print"): one PDF per consignment, joined into one. */
    async airwayBill(trackingNumbers) {
      const pdfs = [];
      for (const cn of trackingNumbers.slice(0, 10)) {
        pdfs.push(
          await get(`${base}/ecom/api/print/label`, {
            query: { consignmentno: cn, shipperdetail: true },
            binary: true
          })
        );
      }
      if (pdfs.length === 1) return pdfs[0];
      const out = await PDFDocument.create();
      for (const buffer of pdfs) {
        const source = await PDFDocument.load(buffer);
        (await out.copyPages(source, source.getPageIndices())).forEach(p => out.addPage(p));
      }
      return Buffer.from(await out.save());
    },

    /** TCS has no load sheet in this API. */
    async loadSheet() {
      throw new CourierError('TCS does not provide a load sheet here');
    },

    /** TCS has no "parcels made on its site, not yet collected" list in this API. */
    async unbooked() {
      return [];
    },

    /** Has TCS paid this parcel's COD out? UAT: the date is read as DD/MM/YYYY, as the guide shows. */
    async paymentStatus(trackingNumber) {
      const json = await get(`${base}/ecom/api/Payment/status`, {
        query: { customerno: account, consignmentno: trackingNumber }
      });
      const row = json.detail?.[0] ?? {};
      return {
        settled: String(row['payment status'] ?? '').toUpperCase() === 'Y',
        settlementDate: row['payment date'] ?? null
      };
    },

    /** TCS has no shipper advice in this API. */
    async shipperAdvice() {
      throw new CourierError('TCS does not take a re-attempt or return instruction here');
    }
  };
};

/** TCS's words for delivered and returned, turned into the words the status check understands. */
const DELIVERED_CODE = 'OK';
const RETURNED_CODE = 'RO';

/**
 * The few fields the app uses, from TCS's tracking record. The newest delivery step decides:
 * code OK is delivered, RO is returned; anything else keeps TCS's own wording, which the app shows
 * as it is when it does not recognise it. TCS's tracking carries no charges (they come on its
 * invoice), so the fees stay 0 and the courier-invoice screen fills them in as it does for any courier.
 */
export const normalizeTracking = (json, trackingNumber) => {
  const steps = json?.deliveryinfo ?? [];
  if (!steps.length) return { trackingNumber, found: false };
  const latest = steps[0];
  const code = String(latest.code ?? '').toUpperCase();
  const status =
    code === DELIVERED_CODE ? 'Delivered' : code === RETURNED_CODE ? 'Returned' : latest.status;
  const checkpoints = [...(json.checkpoints ?? [])].reverse();
  return {
    trackingNumber,
    found: true,
    orderRefNumber: json.shipmentinfo?.[0]?.referenceno,
    cityName: json.shipmentinfo?.[0]?.destination,
    status: status ?? '',
    fee: 0,
    tax: 0,
    reversalFee: 0,
    reversalTax: 0,
    history: checkpoints.map(c => ({ code: '', message: c.status }))
  };
};

/** TCS's own wording when it is readable; the code only picks a fallback. */
const plainMessage = json => {
  const named = (json.error ?? []).map(e => e.errorname).filter(Boolean);
  if (named.length) return `TCS says: ${named.join('; ')}`;
  const message = json.message ?? json.MESSAGE;
  if (message && !/^success/i.test(message)) return `TCS says: ${message}`;
  return 'TCS did not accept the request';
};
