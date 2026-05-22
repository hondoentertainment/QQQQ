// Vercel serverless function backing GET /api/quotes.
//
// Mirrors the /api/quotes route in server.js so the dashboard gets
// near-real-time prices when deployed to Vercel (GitHub Pages cannot run
// this). Set FMP_API_KEY in the Vercel project's environment variables for
// a reliable source; without it the function falls back to Yahoo Finance.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fetchQuotes } from '../lib/quotes.js';

const HOLDINGS_FILE = fileURLToPath(new URL('../data/holdings.json', import.meta.url));

export default async function handler(req, res) {
  try {
    const doc = JSON.parse(await readFile(HOLDINGS_FILE, 'utf8'));
    const tickers = doc.holdings.map((h) => h.ticker);
    const { source, quotes } = await fetchQuotes(tickers, { fmpKey: process.env.FMP_API_KEY });
    const payload = {
      asOf: new Date().toISOString(),
      source,
      count: Object.keys(quotes).length,
      quotes,
    };
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 's-maxage=15, stale-while-revalidate=30');
    res.statusCode = payload.count ? 200 : 503;
    res.end(JSON.stringify(payload));
  } catch (err) {
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: false, reason: String(err) }));
  }
}
