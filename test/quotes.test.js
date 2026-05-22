// Unit tests for the live-quote fetcher. Run with: npm test
// `fetch` is stubbed so these tests make no network requests.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchQuotes } from '../lib/quotes.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A Yahoo chart-API response body for one symbol. */
function yahooBody(price, prevClose) {
  return {
    chart: { result: [{ meta: { regularMarketPrice: price, chartPreviousClose: prevClose } }] },
  };
}

test('fetchQuotes uses FMP when an API key is provided', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => [
      { symbol: 'AAPL', price: 150.126, changesPercentage: '+1.2345%' },
      { symbol: 'msft', price: 400, changesPercentage: 2.5 },
    ],
  });
  const { source, quotes } = await fetchQuotes(['AAPL', 'MSFT'], { fmpKey: 'key' });
  assert.equal(source, 'fmp');
  assert.equal(quotes.AAPL.price, 150.13);
  assert.equal(quotes.AAPL.changePct, 1.23);
  assert.equal(quotes.MSFT.price, 400); // symbol upper-cased
  assert.equal(quotes.MSFT.changePct, 2.5);
});

test('fetchQuotes falls back to Yahoo when the FMP request fails', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes('financialmodelingprep')) return { ok: false };
    return { ok: true, json: async () => yahooBody(101, 100) };
  };
  const { source, quotes } = await fetchQuotes(['AAPL'], { fmpKey: 'key' });
  assert.equal(source, 'yahoo');
  assert.equal(quotes.AAPL.price, 101);
  assert.equal(quotes.AAPL.changePct, 1);
});

test('fetchQuotes uses Yahoo when no API key is given', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => yahooBody(50, 48) });
  const { source, quotes } = await fetchQuotes(['AAPL', 'GOOG'], {});
  assert.equal(source, 'yahoo');
  assert.equal(Object.keys(quotes).length, 2);
  assert.equal(quotes.AAPL.price, 50);
});

test('Yahoo path omits tickers with no usable price', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ chart: { result: [{ meta: {} }] } }),
  });
  const { quotes } = await fetchQuotes(['AAPL'], {});
  assert.deepEqual(quotes, {});
});

test('Yahoo path tolerates a fetch error and returns no quote', async () => {
  globalThis.fetch = async () => {
    throw new Error('network down');
  };
  const { source, quotes } = await fetchQuotes(['AAPL'], {});
  assert.equal(source, 'yahoo');
  assert.deepEqual(quotes, {});
});
