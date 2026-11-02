import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idOf, mapOrder, problemsWith, sameText } from '../utils/shopify/mapper.js';
import { orderNode } from './helpers/shopify.js';

/**
 * Shopify's order as B Ledger needs it, and the plain-words reasons one cannot be brought in by itself.
 */
test('an order is read the way the shop thinks of it: name, phone, address, items, cash on delivery', () => {
  const m = mapOrder(orderNode({ number: 51486, price: 15999, name: 'Arham Ali' }));

  assert.equal(m.id, '51486');
  assert.equal(m.name, '51486');
  assert.equal(m.customerName, 'Arham Ali');
  assert.equal(m.phone, '0300 1234567');
  assert.equal(m.address, 'House 190, Block B');
  assert.equal(m.city, 'Lahore');
  assert.equal(m.total, 15999);
  assert.equal(m.cashOnDelivery, true);
  assert.deepEqual(m.lines[0], {
    title: 'BEIGE MEHFIL',
    variantTitle: 'M',
    variantId: '5148601',
    productId: '51486',
    sku: '',
    quantity: 1,
    unitPrice: 15999
  });
});

test('the numeric tail of a Shopify id is what is kept', () => {
  assert.equal(idOf('gid://shopify/Order/6123'), '6123');
  assert.equal(idOf(null), null);
});

test('the customer name falls back to the customer record when the shipping address has none', () => {
  const node = orderNode({ name: 'Arham Ali' });
  node.shippingAddress.name = '';
  assert.equal(mapOrder(node).customerName, 'Arham Ali');
});

test('an ordinary cash-on-delivery order has no problems', () => {
  assert.deepEqual(problemsWith(mapOrder(orderNode())), []);
});

test('each thing that makes an order unsafe to bring in is named in plain words', () => {
  const why = node => problemsWith(mapOrder(node)).join(' | ');

  assert.match(why(orderNode({ gateways: ['Bank Deposit'] })), /Not cash on delivery/);
  assert.match(why(orderNode({ shipping: 200, total: 16200 })), /shipping charge/);
  assert.match(why(orderNode({ discounts: 500, total: 15500 })), /discount/);
  assert.match(why(orderNode({ total: 15000 })), /not the items' sum/);
  assert.match(why(orderNode({ phone: '' })), /No phone number/);
  assert.match(why(orderNode({ phone: '021 1234567' })), /not a Pakistani mobile number/);
  assert.match(why(orderNode({ city: '' })), /No city/);
  assert.match(why(orderNode({ address: '' })), /No delivery address/);
  assert.match(why(orderNode({ name: '', lines: [] })), /no items/);
});

test('addresses are compared the way a person would: case, spaces and punctuation do not matter', () => {
  assert.equal(sameText('House 190, Block-B', 'house 190 block b'), true);
  assert.equal(sameText('House 190', 'House 191'), false);
  assert.equal(sameText('', ''), false, 'two blanks are not "the same address"');
});
