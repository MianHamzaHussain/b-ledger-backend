import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../middlewares/validate.js';
import { capitalSchema } from '../schemas/finance.js';

// No DB needed — the middleware is pure. Run it and capture next()/req.
const run = (mw, body) =>
  new Promise(resolve => {
    const req = { body };
    mw(req, {}, err => resolve({ err, req }));
  });

test('rejects a bad body with 400 and a field-message array', async () => {
  const { err } = await run(validate(capitalSchema), { amount: -5 }); // no business/direction, bad amount
  assert.equal(err.statusCode, 400);
  assert.ok(Array.isArray(err.message), 'multi-field errors are an array (§4.1)');
  assert.ok(err.message.length >= 1);
});

test('passes a good body: coerces numbers and strips unknown keys', async () => {
  const { err, req } = await run(validate(capitalSchema), {
    business: 'b1',
    amount: '2000', // numeric string
    direction: 'invest',
    method: 'cash',
    junk: 'should be dropped'
  });
  assert.equal(err, undefined);
  assert.equal(req.body.amount, 2000, 'coerced to a number');
  assert.equal(req.body.junk, undefined, 'unknown key stripped');
});

test('preserves the server-stamped createdBy from protect', async () => {
  const { req } = await run(validate(capitalSchema), {
    business: 'b1',
    amount: 2000,
    direction: 'invest',
    createdBy: 'user-1'
  });
  assert.equal(req.body.createdBy, 'user-1', 'JWT-stamped audit field survives validation');
});
