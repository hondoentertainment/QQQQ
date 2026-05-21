#!/usr/bin/env node
// Refreshes data/holdings.json and data/monthly-allocations.json.
// Holdings + weights come from the official Invesco QQQ holdings file;
// live prices come from the Yahoo Finance chart API. Both are best-effort:
// if a source is unreachable the script falls back to the existing data so
// the scheduled job stays green and the site keeps working.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOLDINGS_FILE = path.join(ROOT, 'data', 'holdings.json');
const MONTHLY_FILE = path.join(ROOT, 'data', 'monthly-allocations.json');
const MAX_MONTHS = 24;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const log = (...a) => console.log('[refresh]', ...a);

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

async function fetchInvescoHoldings() {
  const url =
    'https://www.invesco.com/us/financial-products/etfs/holdings/main/holdings/0' +
    '?audienceType=Investor&action=download&ticker=QQQ';
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/csv,application/csv,*/*' },
  });
  if (!res.ok) throw new Error('Invesco HTTP ' + res.status);
  const rows = parseCsv(await res.text()).filter((r) => r.some((c) => c && c.trim()));
  if (rows.length < 10) throw new Error('Invesco CSV too short');

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...keys) => header.findIndex((h) => keys.some((k) => h.includes(k)));
  const iTicker = col('holding ticker', 'ticker');
  const iName = col('name');
  const iWeight = col('weight', 'percentageoffund', 'percent');
  const iSector = col('sector');
  if (iTicker < 0 || iWeight < 0) throw new Error('Invesco CSV columns not recognised');

  const holdings = [];
  for (const r of rows.slice(1)) {
    const ticker = (r[iTicker] || '').trim().toUpperCase();
    const weight = parseFloat((r[iWeight] || '').replace(/[%,\s]/g, ''));
    if (!ticker || !Number.isFinite(weight) || weight <= 0) continue;
    if (/^(CASH|USD|.*RECEIVABLE|.*PAYABLE|.*DEPOSIT)/i.test(ticker)) continue;
    holdings.push({
      ticker,
      name: (iName >= 0 ? r[iName] : '').trim() || ticker,
      sector: (iSector >= 0 ? r[iSector] : '').trim() || 'Unclassified',
      weight: +weight.toFixed(3),
      price: null,
      changePct: null,
    });
  }
  if (holdings.length < 50) throw new Error(`Invesco parsed only ${holdings.length} holdings`);
  return holdings;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function fetchQuote(ticker) {
  const symbol = ticker.replace(/\./g, '-');
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    '?interval=1d&range=2d';
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const meta = (await res.json())?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice;
    if (!Number.isFinite(price)) return null;
    const prev = meta.chartPreviousClose ?? meta.previousClose;
    return {
      price: +price.toFixed(2),
      changePct:
        Number.isFinite(prev) && prev ? +(((price - prev) / prev) * 100).toFixed(2) : null,
    };
  } catch {
    return null;
  }
}

function monthKey(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function main() {
  const now = new Date();
  let holdings;
  let source;

  try {
    log('fetching Invesco QQQ holdings…');
    holdings = await fetchInvescoHoldings();
    source = 'invesco';
    log(`got ${holdings.length} holdings from Invesco`);
  } catch (err) {
    log('Invesco fetch failed:', err.message);
    const prev = await readJson(HOLDINGS_FILE);
    if (!prev?.holdings?.length) {
      console.error('[refresh] no holdings source available — aborting');
      process.exit(1);
    }
    holdings = prev.holdings.map((h) => ({ ...h, price: null, changePct: null }));
    source = prev.source === 'invesco' ? 'invesco-cached' : prev.source || 'seed';
    log(`falling back to existing data (source: ${source}, ${holdings.length} holdings)`);
  }

  log('fetching live quotes…');
  const quotes = await mapLimit(holdings, 6, (h) => fetchQuote(h.ticker));
  let priced = 0;
  holdings.forEach((h, i) => {
    if (quotes[i]) {
      h.price = quotes[i].price;
      h.changePct = quotes[i].changePct;
      priced++;
    }
  });
  log(`priced ${priced}/${holdings.length} holdings`);

  holdings.sort((a, b) => b.weight - a.weight);
  const holdingsDoc = {
    fund: 'QQQ',
    name: 'Invesco QQQ Trust (Nasdaq-100 Index)',
    legacyTicker: 'QQQQ',
    asOf: now.toISOString(),
    source,
    count: holdings.length,
    totalWeight: +holdings.reduce((s, h) => s + h.weight, 0).toFixed(2),
    holdings,
  };
  await writeFile(HOLDINGS_FILE, JSON.stringify(holdingsDoc, null, 2) + '\n');
  log('wrote', path.relative(ROOT, HOLDINGS_FILE));

  const mk = monthKey(now);
  const monthly = (await readJson(MONTHLY_FILE)) || { fund: 'QQQ', months: [], allocations: {} };
  monthly.months = Array.isArray(monthly.months) ? monthly.months : [];
  monthly.allocations = monthly.allocations || {};
  if (!monthly.months.includes(mk)) monthly.months.push(mk);
  monthly.months.sort();
  if (monthly.months.length > MAX_MONTHS) monthly.months = monthly.months.slice(-MAX_MONTHS);
  const keep = new Set(monthly.months);

  for (const h of holdings) {
    const rec = monthly.allocations[h.ticker] || {};
    rec[mk] = h.weight;
    for (const k of Object.keys(rec)) if (!keep.has(k)) delete rec[k];
    monthly.allocations[h.ticker] = rec;
  }
  monthly.updatedAt = now.toISOString();
  await writeFile(MONTHLY_FILE, JSON.stringify(monthly, null, 2) + '\n');
  log('wrote', path.relative(ROOT, MONTHLY_FILE), `(${mk} snapshot)`);
  log('done.');
}

main().catch((err) => {
  console.error('[refresh] fatal:', err);
  process.exit(1);
});
