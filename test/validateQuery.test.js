import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { validateQuery } from '../middlewares/validate.js';
import errorHandler from '../middlewares/errorHandler.js';
import {
  cashbookQuerySchema,
  courierWalletQuerySchema,
  courierWalletParcelsQuerySchema
} from '../schemas/finance.js';

/**
 * A GET's query string is checked before the controller, like a body is: numbers coerced, defaults filled, unknown
 * keys dropped, and a bad value is the same 400 error array as everywhere else. A real Express 5 app, because
 * Express 5 gives `req.query` a getter only — the middleware has to replace it properly.
 */
const ID = 'a'.repeat(24);
let server;
let base;

before(async () => {
  const app = express();
  const echo = (req, res) => res.json({ success: true, query: req.query });
  app.get('/cashbook', validateQuery(cashbookQuerySchema), echo);
  app.get('/wallet', validateQuery(courierWalletQuerySchema), echo);
  app.get('/parcels', validateQuery(courierWalletParcelsQuerySchema), echo);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const get = async (path, query) => {
  const res = await fetch(`${base}${path}?${new URLSearchParams(query)}`);
  return { status: res.status, body: await res.json() };
};

test('the wallet list gets its defaults and numbers, and loses what it did not ask for', async () => {
  const { status, body } = await get('/parcels', {
    business: ID,
    account: ID,
    limit: '5',
    evil: '1'
  });
  assert.equal(status, 200);
  assert.deepEqual(body.query, { business: ID, account: ID, tab: 'all', page: 1, limit: 5 });
});

test('a tab we do not know, a page of zero or a page that is too big is a 400 with the error array', async () => {
  const tab = await get('/parcels', { business: ID, account: ID, tab: 'everything' });
  assert.equal(tab.status, 400);
  assert.equal(tab.body.success, false);
  assert.match(tab.body.error[0], /Choose all, paid, upcoming or charges/);

  assert.equal((await get('/parcels', { business: ID, account: ID, page: '0' })).status, 400);
  assert.equal((await get('/parcels', { business: ID, account: ID, limit: '1000' })).status, 400);
  assert.equal((await get('/parcels', { business: ID, account: ID, limit: '1.5' })).status, 400);
});

test('a search is trimmed, kept as typed (a word, not a pattern), and capped', async () => {
  const ok = await get('/parcels', { business: ID, account: ID, search: '  .*  ' });
  assert.equal(ok.body.query.search, '.*');
  assert.equal(
    (await get('/parcels', { business: ID, account: ID, search: 'x'.repeat(101) })).status,
    400
  );
});

test('a business or wallet that is not an id is refused, in words', async () => {
  const noBusiness = await get('/wallet', { account: ID });
  assert.equal(noBusiness.status, 400);
  assert.match(noBusiness.body.error[0], /Select a business/);
  assert.equal((await get('/wallet', { business: 'nope', account: ID })).status, 400);
  assert.equal((await get('/wallet', { business: ID, account: 'nope' })).status, 400);
  assert.equal((await get('/wallet', { business: ID, account: ID })).status, 200);
});

test('the cash book takes cash, bank, a money account or a partner — and nothing else', async () => {
  for (const account of ['cash', 'bank', ID, `partner:${ID}`]) {
    assert.equal((await get('/cashbook', { business: ID, account })).status, 200, account);
  }
  assert.equal((await get('/cashbook', { business: ID })).status, 200, 'no account means cash');
  const bad = await get('/cashbook', { business: ID, account: 'junk' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error[0], /money accounts/);
  assert.equal((await get('/cashbook', { account: 'cash' })).status, 400, 'no business');
});

test('the cash book keeps its day bounds, as the client sends them', async () => {
  const from = '2026-11-04T19:00:00.000Z';
  const to = '2026-11-05T18:59:59.999Z';
  const { body } = await get('/cashbook', { business: ID, account: 'cash', from, to });
  assert.deepEqual(body.query, { business: ID, account: 'cash', from, to });
});
