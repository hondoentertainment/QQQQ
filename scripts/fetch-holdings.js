#!/usr/bin/env node
// Refreshes data/holdings.json, data/monthly-allocations.json and data/changes.json.
//
// Holdings + weights: Invesco official QQQ holdings file, falling back to
// Financial Modeling Prep when FMP_API_KEY is set, then to the last good data.
// Prices: see lib/quotes.js. All sources are best-effort so the scheduled
// job stays green and the site keeps working even when a source is down.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchQuotes } from '../lib/quotes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOLDINGS_FILE = path.join(ROOT, 'data', 'holdings.json');
const MONTHLY_FILE = path.join(ROOT, 'data', 'monthly-allocations.json');
const CHANGES_FILE = path.join(ROOT, 'data', 'changes.json');
const MAX_MONTHS = 24;
const MAX_CHANGE_EVENTS = 50;
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

async function fetchFmpHoldings(apiKey) {
  const url =
    `https://financialmodelingprep.com/api/v3/etf-holder/QQQ?apikey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('FMP HTTP ' + res.status);
  const arr = await res.json();
  if (!Array.isArray(arr)) throw new Error('FMP unexpected response');

  const holdings = [];
  for (const r of arr) {
    const ticker = String(r.asset || '').trim().toUpperCase();
    const weight = Number(r.weightPercentage);
    if (!ticker || !Number.isFinite(weight) || weight <= 0) continue;
    holdings.push({
      ticker,
      name: String(r.name || ticker).trim(),
      sector: 'Unclassified',
      weight: +weight.toFixed(3),
      price: null,
      changePct: null,
    });
  }
  if (holdings.length < 50) throw new Error(`FMP parsed only ${holdings.length} holdings`);
  return holdings;
}

function monthKey(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const LIVE_SOURCES = new Set(['invesco', 'fmp', 'invesco-cached', 'fmp-cached']);

async function main() {
  const now = new Date();
  const fmpKey = process.env.FMP_API_KEY || '';
  const prev = await readJson(HOLDINGS_FILE);

  let holdings = null;
  let source = null;

  try {
    log('fetching Invesco QQQ holdings…');
    holdings = await fetchInvescoHoldings();
    source = 'invesco';
    log(`got ${holdings.length} holdings from Invesco`);
  } catch (err) {
    log('Invesco fetch failed:', err.message);
  }

  if (!holdings && fmpKey) {
    try {
      log('trying Financial Modeling Prep…');
      holdings = await fetchFmpHoldings(fmpKey);
      source = 'fmp';
      log(`got ${holdings.length} holdings from FMP`);
    } catch (err) {
      log('FMP fetch failed:', err.message);
    }
  } else if (!holdings) {
    log('FMP_API_KEY not set — skipping FMP fallback');
  }

  if (!holdings) {
    if (!prev?.holdings?.length) {
      console.error('[refresh] no holdings source available — aborting');
      process.exit(1);
    }
    holdings = prev.holdings.map((h) => ({ ...h, price: null, changePct: null }));
    source = LIVE_SOURCES.has(prev.source)
      ? (prev.source.endsWith('-cached') ? prev.source : prev.source + '-cached')
      : prev.source || 'seed';
    log(`falling back to existing data (source: ${source}, ${holdings.length} holdings)`);
  }

  // Carry sector labels over from the previous snapshot when a source omits them.
  if (prev?.holdings?.length) {
    const prevSector = new Map(prev.holdings.map((h) => [h.ticker, h.sector]));
    for (const h of holdings) {
      if ((!h.sector || h.sector === 'Unclassified') && prevSector.get(h.ticker)) {
        h.sector = prevSector.get(h.ticker);
      }
    }
  }

  log('fetching live quotes…');
  const { source: quoteSource, quotes } = await fetchQuotes(
    holdings.map((h) => h.ticker),
    { fmpKey }
  );
  let priced = 0;
  for (const h of holdings) {
    const q = quotes[h.ticker];
    if (q) {
      h.price = q.price;
      h.changePct = q.changePct;
      priced++;
    }
  }
  log(`priced ${priced}/${holdings.length} holdings via ${quoteSource}`);

  holdings.sort((a, b) => b.weight - a.weight);

  // Record constituent additions / removals between live snapshots.
  if (prev?.holdings?.length && LIVE_SOURCES.has(prev.source) && (source === 'invesco' || source === 'fmp')) {
    const prevByTicker = new Map(prev.holdings.map((h) => [h.ticker, h]));
    const nowByTicker = new Map(holdings.map((h) => [h.ticker, h]));
    const added = holdings
      .filter((h) => !prevByTicker.has(h.ticker))
      .map((h) => ({ ticker: h.ticker, name: h.name }));
    const removed = prev.holdings
      .filter((h) => !nowByTicker.has(h.ticker))
      .map((h) => ({ ticker: h.ticker, name: h.name }));
    if (added.length || removed.length) {
      const changes = (await readJson(CHANGES_FILE)) || { events: [] };
      changes.events = Array.isArray(changes.events) ? changes.events : [];
      changes.events.unshift({ date: now.toISOString(), added, removed });
      changes.events = changes.events.slice(0, MAX_CHANGE_EVENTS);
      await writeFile(CHANGES_FILE, JSON.stringify(changes, null, 2) + '\n');
      log(`recorded index change: +${added.length} / -${removed.length}`);
    }
  }

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
