import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';

import express from 'express';

/**
 * Guards the Express-5 "bodiless request → req.body is undefined" trap that 500'd
 * the invite/reinvite and other action routes. Mirrors server.js's middleware:
 * the JSON parser, then the normaliser that defaults req.body to {}. Proves that
 * both a WRITE (protect stamps createdBy) and a DELETE (roleController strips
 * fields) survive a POST with no body — the exact shapes that were crashing.
 */
function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.body == null) req.body = {};
    next();
  });
  app.post('/stamp', (req, res) => {
    req.body.createdBy = 'u1'; // protect-style audit stamp
    res.json({ ok: true, createdBy: req.body.createdBy });
  });
  app.post('/strip', (req, res) => {
    delete req.body.fullAccess; // roleController-style
    res.json({ ok: true });
  });
  return app;
}

const bodilessPost = (app, path) => {
  const srv = app.listen(0);
  const { port } = srv.address();
  return new Promise(resolve => {
    const req = http.request({ port, path, method: 'POST' }, res => {
      res.resume();
      res.on('end', () => {
        srv.close();
        resolve(res.statusCode);
      });
    });
    req.end(); // no body at all
  });
};

test('bodiless POST that WRITES req.body.* returns 200, not 500', async () => {
  assert.equal(await bodilessPost(makeApp(), '/stamp'), 200);
});

test('bodiless POST that DELETES req.body.* returns 200, not 500', async () => {
  assert.equal(await bodilessPost(makeApp(), '/strip'), 200);
});
