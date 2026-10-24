import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, makeBusiness, runHandler } from './helpers/db.js';
import Business from '../models/Business.js';
import { updateBusiness } from '../controllers/businessController.js';
import { businessCreateSchema, businessUpdateSchema } from '../schemas/businesses.js';
import { LOGO_MAX_BYTES, LOGO_MAX_CHARS } from '../utils/constants.js';

/**
 * A business has a small logo and an accent colour. The logo is shown on every screen
 * for everyone assigned to it, so only a small png/jpeg/webp image is accepted — never
 * an SVG (which can carry script) or a link to somewhere else.
 */

before(connect);
after(disconnect);
afterEach(clear);

const base = { name: 'Acme', category: 'c1' };
// What the browser sends after resizing: a short base64 image.
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const png = `data:image/png;base64,${PIXEL}`;

const logoOk = logo => businessCreateSchema.safeParse({ ...base, logo }).success;

test('a png, jpeg or webp data image is accepted', () => {
  assert.equal(logoOk(png), true);
  assert.equal(logoOk(`data:image/jpeg;base64,${PIXEL}`), true);
  assert.equal(logoOk(`data:image/webp;base64,${PIXEL}`), true);
});

test('anything else is refused: SVG, other types, links, plain text, and junk after the data', () => {
  assert.equal(logoOk(`data:image/svg+xml;base64,${PIXEL}`), false, 'svg can carry script');
  assert.equal(logoOk(`data:image/gif;base64,${PIXEL}`), false);
  assert.equal(logoOk('https://example.com/logo.png'), false, 'a link would load from elsewhere');
  assert.equal(logoOk('javascript:alert(1)'), false);
  assert.equal(logoOk('not an image'), false);
  assert.equal(logoOk(`data:image/png;base64,${PIXEL}"><script>`), false);
  assert.equal(logoOk(`data:image/png;charset=utf-8,${PIXEL}`), false);
});

test('a logo over 150 KB is refused, one right at the limit is not', () => {
  const prefix = 'data:image/png;base64,';
  const room = LOGO_MAX_CHARS - prefix.length;
  assert.equal(logoOk(prefix + 'A'.repeat(room)), true);
  assert.equal(logoOk(prefix + 'A'.repeat(room + 1)), false);
  assert.equal(LOGO_MAX_BYTES, 150 * 1024);
});

test('a brand colour must be #rrggbb', () => {
  const colour = brandColor => businessCreateSchema.safeParse({ ...base, brandColor }).success;
  assert.equal(colour('#1a73e8'), true);
  assert.equal(colour('#ABCDEF'), true);
  assert.equal(colour('blue'), false);
  assert.equal(colour('#fff'), false);
  assert.equal(colour('#12345g'), false);
  assert.equal(colour('url(javascript:x)'), false);
});

test('the logo and colour are optional, and null removes them', () => {
  assert.equal(businessCreateSchema.safeParse(base).success, true);
  const cleared = businessUpdateSchema.parse({ logo: null, brandColor: null });
  assert.equal(cleared.logo, null);
  assert.equal(cleared.brandColor, null);
});

test('a business keeps its logo and colour, and an update can remove them', async () => {
  const biz = await makeBusiness();
  const saved = (
    await runHandler(updateBusiness, {
      resource: await Business.findById(biz._id),
      body: businessUpdateSchema.parse({ logo: png, brandColor: '#1a73e8' })
    })
  ).body.data;
  assert.equal(saved.logo, png);
  assert.equal(saved.brandColor, '#1a73e8');
  assert.equal((await Business.findById(biz._id)).logo, png);

  await runHandler(updateBusiness, {
    resource: await Business.findById(biz._id),
    body: businessUpdateSchema.parse({ logo: null, brandColor: null })
  });
  const after = await Business.findById(biz._id);
  assert.ok(!after.logo);
  assert.ok(!after.brandColor);
});

test('the model refuses an oversized logo or a bad colour even if the request check were skipped', async () => {
  const biz = await makeBusiness();
  const doc = await Business.findById(biz._id);
  doc.logo = 'data:image/png;base64,' + 'A'.repeat(LOGO_MAX_CHARS);
  await assert.rejects(doc.save(), /too large/);
  const doc2 = await Business.findById(biz._id);
  doc2.brandColor = 'red';
  await assert.rejects(doc2.save(), /colour/);
});
