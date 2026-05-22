// Unit tests for the Vercel serverless function api/quotes.js.
// Run with: npm test  (`fetch` is stubbed; no network access).
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/quotes.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Minimal stand-in for a Node ServerResponse. */
function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    end(chunk) {
      this.body = chunk || '';
    },
  };
}

test('api/quotes returns a quote payload from the live source', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      chart: { result: [{ meta: { regularMarketPrice: 100, chartPreviousClose: 99 } }] },
    }),
  });
  const res = mockRes();
  await handler({ method: 'GET' }, res);

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /json/);
  const payload = JSON.parse(res.body);
  assert.equal(payload.source, 'yahoo');
  assert.ok(payload.count > 0);
  assert.equal(payload.count, Object.keys(payload.quotes).length);
});

test('api/quotes responds 503 when the quote source yields nothing', async () => {
  globalThis.fetch = async () => {
    throw new Error('network down');
  };
  const res = mockRes();
  await handler({ method: 'GET' }, res);

  assert.equal(res.statusCode, 503);
  assert.equal(JSON.parse(res.body).count, 0);
});
