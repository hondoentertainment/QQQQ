#!/usr/bin/env node
// Refreshes data/holdings.json, data/monthly-allocations.json and data/changes.json.
//
// Holdings + weights: Invesco official QQQ holdings file, falling back to
// Financial Modeling Prep when FMP_API_KEY is set, then to the last good data.
// Prices: see lib/quotes.js. All sources are best-effort and validated, so a
// flaky or malformed source can't corrupt the committed data or break the job.
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchQuotes } from '../lib/quotes.js';
import {
  parseInvescoCsv,
  parseFmpHoldings,
  validateHoldings,
  diffConstituents,
  monthKey,
  applyMonthlySnapshot,
  isFallbackSource,
} from '../lib/holdings.js';

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

async function fetchInvescoHoldings() {
  const url =
    'https://www.invesco.com/us/financial-products/etfs/holdings/main/holdings/0' +
    '?audienceType=Investor&action=download&ticker=QQQ';
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/csv,application/csv,*/*' },
  });
  if (!res.ok) throw new Error('Invesco HTTP ' + res.status);
  return validateHoldings(parseInvescoCsv(await res.text()), 'Invesco');
}

async function fetchFmpHoldings(apiKey) {
  const url =
    `https://financialmodelingprep.com/api/v3/etf-holder/QQQ?apikey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('FMP HTTP ' + res.status);
  return validateHoldings(parseFmpHoldings(await res.json()), 'FMP');
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
      ? prev.source.endsWith('-cached') ? prev.source : prev.source + '-cached'
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
    const { added, removed } = diffConstituents(prev.holdings, holdings);
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
  const monthly = await readJson(MONTHLY_FILE);
  const updated = applyMonthlySnapshot(monthly, holdings, mk, MAX_MONTHS);
  updated.updatedAt = now.toISOString();
  await writeFile(MONTHLY_FILE, JSON.stringify(updated, null, 2) + '\n');
  log('wrote', path.relative(ROOT, MONTHLY_FILE), `(${mk} snapshot)`);

  // When running in GitHub Actions, expose whether this run could only serve
  // fallback (cached / seed) data so the refresh workflow can alert on a
  // silently stale dashboard. A no-op outside Actions.
  const fellBack = isFallbackSource(source);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `source=${source}\nfallback=${fellBack}\n`);
  }
  if (fellBack) log(`WARNING: no live source reached — serving fallback data (source: ${source})`);
  log('done.');
}

main().catch((err) => {
  console.error('[refresh] fatal:', err);
  process.exit(1);
});
