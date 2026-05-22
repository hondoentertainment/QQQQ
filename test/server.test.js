// Integration tests for the static server and its API routes.
// Run with: npm test
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { server } from '../server.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function start() {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}
function stop() {
  return new Promise((resolve) => server.close(resolve));
}

/** Make a request to the running server using node:http (so `fetch` stays free to stub). */
function request(reqPath, { method = 'GET' } = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('server', async (t) => {
  await start();
  t.after(stop);

  await t.test('serves index.html at /', async () => {
    const res = await request('/');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.body, /QQQQ/);
  });

  await t.test('serves static assets with the right content type', async () => {
    const css = await request('/styles.css');
    assert.equal(css.status, 200);
    assert.match(css.headers['content-type'], /text\/css/);

    const js = await request('/app.js');
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'], /javascript/);
  });

  await t.test('returns 404 for a missing file', async () => {
    const res = await request('/does-not-exist.txt');
    assert.equal(res.status, 404);
  });

  await t.test('does not serve files outside the web root', async () => {
    // URL normalization clamps `..` at the root, so an escape attempt
    // resolves to a non-existent path under ROOT rather than a system file.
    const res = await request('/../../../../../etc/hostname');
    assert.notEqual(res.status, 200);
  });

  await t.test('rejects a non-POST request to /api/refresh with 405', async () => {
    const res = await request('/api/refresh');
    assert.equal(res.status, 405);
    assert.equal(JSON.parse(res.body).ok, false);
  });

  await t.test('/api/quotes returns live quotes from the quote source', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        chart: { result: [{ meta: { regularMarketPrice: 100, chartPreviousClose: 99 } }] },
      }),
    });
    const res = await request('/api/quotes');
    assert.equal(res.status, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.source, 'yahoo');
    assert.ok(payload.count > 0);
  });
});
