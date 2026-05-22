// Zero-dependency static server for the QQQQ component tracker.
//   node server.js                  -> serve the dashboard on :3000
//   REFRESH_MINUTES=30 node server.js -> also refresh data on that interval
// POST /api/refresh triggers an on-demand data refresh.
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchQuotes } from './lib/quotes.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const FETCH_SCRIPT = path.join(ROOT, 'scripts', 'fetch-holdings.js');
const HOLDINGS_FILE = path.join(ROOT, 'data', 'holdings.json');
const QUOTE_CACHE_MS = 15000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

let refreshing = false;
function runRefresh() {
  return new Promise((resolve) => {
    if (refreshing) return resolve({ ok: false, reason: 'refresh already in progress' });
    refreshing = true;
    const started = Date.now();
    const child = spawn(process.execPath, [FETCH_SCRIPT], { stdio: 'inherit' });
    child.on('exit', (code) => {
      refreshing = false;
      resolve({ ok: code === 0, code, ms: Date.now() - started });
    });
    child.on('error', (err) => {
      refreshing = false;
      resolve({ ok: false, reason: String(err) });
    });
  });
}

let quoteCache = { at: 0, payload: null };
async function getLiveQuotes() {
  if (quoteCache.payload && Date.now() - quoteCache.at < QUOTE_CACHE_MS) {
    return quoteCache.payload;
  }
  const doc = JSON.parse(await readFile(HOLDINGS_FILE, 'utf8'));
  const tickers = doc.holdings.map((h) => h.ticker);
  const { source, quotes } = await fetchQuotes(tickers, { fmpKey: process.env.FMP_API_KEY });
  const payload = { asOf: new Date().toISOString(), source, count: Object.keys(quotes).length, quotes };
  quoteCache = { at: Date.now(), payload };
  return payload;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/quotes') {
    try {
      const payload = await getLiveQuotes();
      res.writeHead(payload.count ? 200 : 503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, reason: String(err) }));
    }
  }

  if (url.pathname === '/api/refresh') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, reason: 'use POST' }));
    }
    const result = await runRefresh();
    res.writeHead(result.ok ? 200 : 503, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(result));
  }

  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  const filePath = path.normalize(path.join(ROOT, pathname));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  createReadStream(filePath).pipe(res);
});

// Only listen when run directly (`node server.js`), not when imported by tests.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  server.listen(PORT, () => {
    console.log(`QQQQ component tracker -> http://localhost:${PORT}`);
  });

  const refreshMinutes = Number(process.env.REFRESH_MINUTES) || 0;
  if (refreshMinutes > 0) {
    console.log(`auto-refresh enabled: every ${refreshMinutes} min`);
    setInterval(() => {
      console.log('[server] running scheduled refresh');
      runRefresh();
    }, refreshMinutes * 60 * 1000);
  }
}

export { server };
