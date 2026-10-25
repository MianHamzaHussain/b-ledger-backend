import crypto from 'node:crypto';
import { makeBusiness, makeProduct, makeParty, runHandler, userId } from './db.js';
import Order from '../../models/Order.js';
import Party from '../../models/Party.js';
import '../../models/Category.js';
import { createOrder, updateOrderStatus } from '../../controllers/orderController.js';
import { saveConnection } from '../../controllers/courierConnectionController.js';
import { orderCreateSchema, orderStatusSchema } from '../../schemas/orders.js';
import { courierConnectionSchema } from '../../schemas/parties.js';
import { courierDeps } from '../../utils/couriers/index.js';

/**
 * Shared set-up for the courier tests: a business with a connected PostEx courier, an order, and a
 * fake PostEx that books parcels and answers tracking. Nothing here can reach the real service.
 */
process.env.COURIER_SECRET_KEY ??= crypto.randomBytes(32).toString('hex');

export const admin = { id: userId, role: { fullAccess: true } };
export const KEY = 'pk_secret_key_123';

export const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const restoreFetch = () => {
  courierDeps.fetchImpl = (...a) => fetch(...a);
};

/**
 * A fake PostEx. `tracking` maps a tracking number to the record it should answer with (see
 * `track`), `failBulk` makes the bulk call fail so the one-by-one fallback is exercised.
 */
export const fakePostex = ({
  cities = ['Lahore', 'Karachi'],
  failCreate,
  tracking = {},
  failBulk
} = {}) => {
  const creates = [];
  const calls = [];
  courierDeps.fetchImpl = async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('get-operational-city')) {
      return reply({ statusCode: '200', dist: cities.map(c => ({ operationalCityName: c })) });
    }
    if (u.includes('create-order')) {
      creates.push(JSON.parse(init.body));
      if (failCreate) return reply({ statusCode: '400', statusMessage: failCreate }, 400);
      return reply({
        statusCode: '200',
        dist: { trackingNumber: `CX-${1000 + creates.length}`, orderStatus: 'UnBooked' }
      });
    }
    if (u.includes('track-bulk-order')) {
      if (failBulk) return reply({ statusCode: '500' }, 500);
      const numbers = new URL(u).searchParams.get('trackingNumber').split(',');
      return reply({
        statusCode: '200',
        dist: numbers.map(n =>
          tracking[n]
            ? {
                trackingNumber: n,
                message: 'SUCCESSFULLY RETRIEVE ORDER',
                trackingResponse: { trackingNumber: n, ...tracking[n] }
              }
            : { trackingNumber: n, message: 'ORDER NOT FOUND', trackingResponse: null }
        )
      });
    }
    if (u.includes('track-order/')) {
      const n = decodeURIComponent(u.split('track-order/')[1]);
      if (!tracking[n]) return reply({ statusCode: '404', statusMessage: 'Order not found' }, 404);
      if (tracking[n] === 'boom') return reply({ statusCode: '500' }, 500);
      return reply({ statusCode: '200', dist: { trackingNumber: n, ...tracking[n] } });
    }
    return reply({ statusCode: '200', dist: [] });
  };
  return { creates, calls };
};

let n = 0;
export const setupOrder = async ({
  city = 'Lahore',
  address = 'House 5, Gulberg',
  phone = '0300-1234567',
  connected = true,
  name = 'Sana Khan'
} = {}) => {
  const biz = await makeBusiness({ name: `Courier Shop ${(n += 1)}` });
  const courier = await makeParty(biz._id, 'courier');
  if (connected) {
    await runHandler(saveConnection, {
      user: admin,
      resource: courier,
      body: courierConnectionSchema.parse({
        provider: 'postex',
        token: KEY,
        pickupAddressCode: '001'
      })
    });
    await runHandler(saveConnection, {
      user: admin,
      resource: await Party.findById(courier._id),
      body: courierConnectionSchema.parse({ isEnabled: true })
    });
  }
  const product = await makeProduct(biz._id);
  const out = await runHandler(createOrder, {
    user: admin,
    body: orderCreateSchema.parse({
      business: String(biz._id),
      customerName: name,
      contactNumber: phone,
      city,
      deliveryAddress: address,
      customerNote: 'Gift pack',
      items: [
        {
          product: String(product._id),
          variantId: String(product.variants[0]._id),
          quantity: 2,
          unitPrice: 2000
        }
      ]
    })
  });
  return { biz, courier, order: await Order.findById(out.body.data._id) };
};

export const dispatchBooked = (order, courier, extra = {}) =>
  runHandler(updateOrderStatus, {
    user: admin,
    resource: order,
    body: orderStatusSchema.parse({
      status: 'dispatched',
      courier: String(courier._id),
      bookWithCourier: true,
      ...extra
    })
  });
