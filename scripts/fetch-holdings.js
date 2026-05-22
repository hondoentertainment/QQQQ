#!/usr/bin/env node
// Refreshes data/holdings.json, data/monthly-allocations.json and data/changes.json.
//
// Holdings + weights: Invesco official QQQ holdings file, falling back to
// Financial Modeling Prep when FMP_API_KEY is set, then SEC N-PORT filings,
// then to the last good data. Prices: see lib/quotes.js.
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
  applyPriceSnapshot,
  isFallbackSource,
  buildNameTickerMap,
  parseSecNportHoldings,
  buildRefreshStatus,
  validateHoldingsDocument,
  validateMonthlyDocument,
  validateRefreshStatus,
  SCHEMA_VERSION,
} from '../lib/holdings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOLDINGS_FILE = path.join(ROOT, 'data', 'holdings.json');
const MONTHLY_FILE = path.join(ROOT, 'data', 'monthly-allocations.json');
const CHANGES_FILE = path.join(ROOT, 'data', 'changes.json');
const PRICE_HISTORY_FILE = path.join(ROOT, 'data', 'price-history.json');
const REFRESH_STATUS_FILE = path.join(ROOT, 'data', 'refresh-status.json');
const NAME_OVERRIDES_FILE = path.join(ROOT, 'data', 'name-overrides.json');
const MAX_MONTHS = 24;
const MAX_CHANGE_EVENTS = 50;
const MAX_PRICE_DAYS = 180;
const SEC_CIK = '1067839';
const FUNDAMENTAL_FIELDS = ['marketCap', 'pe', 'yearHigh', 'yearLow'];
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SEC_UA = 'QQQQ-Tracker admin@example.com';

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
    headers: {
      'User-Agent': UA,
      Accept: 'text/csv,application/csv,*/*',
      Referer: 'https://www.invesco.com/us/en/financial-products/etfs/invesco-qqq-trust-series-1.html',
    },
  });
  if (!res.ok) throw new Error('Invesco HTTP ' + res.status);
  return validateHoldings(parseInvescoCsv(await res.text()), 'Invesco');
}

async function fetchFmpHoldings(apiKey) {
  const headers = { 'User-Agent': UA, apikey: apiKey };
  const key = encodeURIComponent(apiKey);

  const stableUrl =
    `https://financialmodelingprep.com/stable/etf/holdings?symbol=QQQ&apikey=${key}`;
  let res = await fetch(stableUrl, { headers });
  if (res.ok) {
    return validateHoldings(parseFmpHoldings(await res.json()), 'FMP stable');
  }
  const stableStatus = res.status;

  const legacyUrl =
    `https://financialmodelingprep.com/api/v3/etf-holder/QQQ?apikey=${key}`;
  res = await fetch(legacyUrl, { headers });
  if (!res.ok) throw new Error(`FMP HTTP stable=${stableStatus} legacy=${res.status}`);
  return validateHoldings(parseFmpHoldings(await res.json()), 'FMP');
}

async function fetchSecHoldings(nameToTicker) {
  const headers = { 'User-Agent': SEC_UA, Accept: 'application/json' };
  const subRes = await fetch(
    'https://data.sec.gov/submissions/CIK0001067839.json',
    { headers }
  );
  if (!subRes.ok) throw new Error('SEC submissions HTTP ' + subRes.status);
  const sub = await subRes.json();
  const recent = sub.filings?.recent;
  if (!recent?.form?.length) throw new Error('SEC submissions has no filings');

  let adsh = null;
  let docPath = 'primary_doc.xml';
  for (let i = 0; i < recent.form.length; i++) {
    if (recent.form[i] === 'NPORT-P') {
      adsh = recent.accessionNumber[i].replace(/-/g, '');
      const primary = recent.primaryDocument[i] || 'primary_doc.xml';
      docPath = primary.includes('/') ? primary.split('/').pop() : primary;
      break;
    }
  }
  if (!adsh) throw new Error('SEC N-PORT filing not found');

  const xmlUrl = `https://www.sec.gov/Archives/edgar/data/${SEC_CIK}/${adsh}/${docPath}`;
  const xmlRes = await fetch(xmlUrl, { headers: { 'User-Agent': SEC_UA } });
  if (!xmlRes.ok) throw new Error('SEC N-PORT HTTP ' + xmlRes.status);
  const xml = await xmlRes.text();
  const nameOverrides = (await readJson(NAME_OVERRIDES_FILE)) || {};
  const nameMap = buildNameTickerMap([], nameOverrides);
  for (const [k, v] of nameToTicker) nameMap.set(k, v);
  const { holdings, unmapped } = parseSecNportHoldings(xml, nameMap);
  if (unmapped.length) {
    log(`SEC N-PORT: ${unmapped.length} names could not be mapped`);
    unmapped.slice(0, 5).forEach((u) => log(`  unmapped: ${u.name} (${u.weight}%)`));
  }
  return { holdings: validateHoldings(holdings, 'SEC N-PORT'), unmapped };
}

const LIVE_SOURCES = new Set(['invesco', 'fmp', 'sec-nport', 'invesco-cached', 'fmp-cached']);

async function main() {
  const now = new Date();
  const fmpKey = process.env.FMP_API_KEY || '';
  const prev = await readJson(HOLDINGS_FILE);
  const attempts = [];

  let holdings = null;
  let source = null;
  let unmapped = [];

  try {
    log('fetching Invesco QQQ holdings…');
    holdings = await fetchInvescoHoldings();
    source = 'invesco';
    attempts.push({ source: 'invesco', ok: true, count: holdings.length });
    log(`got ${holdings.length} holdings from Invesco`);
  } catch (err) {
    attempts.push({ source: 'invesco', ok: false, error: err.message });
    log('Invesco fetch failed:', err.message);
  }

  if (!holdings && fmpKey) {
    try {
      log('trying Financial Modeling Prep…');
      holdings = await fetchFmpHoldings(fmpKey);
      source = 'fmp';
      attempts.push({ source: 'fmp', ok: true, count: holdings.length });
      log(`got ${holdings.length} holdings from FMP`);
    } catch (err) {
      attempts.push({ source: 'fmp', ok: false, error: err.message });
      log('FMP fetch failed:', err.message);
    }
  } else if (!holdings && !fmpKey) {
    attempts.push({ source: 'fmp', ok: false, error: 'FMP_API_KEY not set' });
    log('FMP_API_KEY not set — skipping FMP fallback');
  }

  if (!holdings && prev?.holdings?.length) {
    try {
      log('trying SEC N-PORT filing…');
      const nameMap = buildNameTickerMap(prev.holdings, (await readJson(NAME_OVERRIDES_FILE)) || {});
      const sec = await fetchSecHoldings(nameMap);
      holdings = sec.holdings;
      unmapped = sec.unmapped;
      source = 'sec-nport';
      attempts.push({ source: 'sec-nport', ok: true, count: holdings.length });
      log(`got ${holdings.length} holdings from SEC N-PORT`);
    } catch (err) {
      attempts.push({ source: 'sec-nport', ok: false, error: err.message });
      log('SEC N-PORT fetch failed:', err.message);
    }
  } else if (!holdings) {
    attempts.push({ source: 'sec-nport', ok: false, error: 'no prior snapshot for name map' });
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
    attempts.push({ source: 'cache', ok: true, count: holdings.length, from: source });
    log(`falling back to existing data (source: ${source}, ${holdings.length} holdings)`);
  }

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
    [...holdings.map((h) => h.ticker), 'QQQ'],
    { fmpKey }
  );
  let priced = 0;
  for (const h of holdings) {
    const q = quotes[h.ticker];
    if (q) {
      h.price = q.price;
      h.changePct = q.changePct;
      for (const f of FUNDAMENTAL_FIELDS) {
        if (Number.isFinite(q[f])) h[f] = q[f];
      }
      priced++;
    }
  }
  log(`priced ${priced}/${holdings.length} holdings via ${quoteSource}`);

  holdings.sort((a, b) => b.weight - a.weight);

  if (prev?.holdings?.length && LIVE_SOURCES.has(prev.source) &&
      (source === 'invesco' || source === 'fmp' || source === 'sec-nport')) {
    const { added, removed } = diffConstituents(prev.holdings, holdings);
    if (added.length || removed.length) {
      const changes = (await readJson(CHANGES_FILE)) || { events: [] };
      changes.events = Array.isArray(changes.events) ? changes.events : [];
      changes.events.unshift({ date: now.toISOString(), added, removed });
      changes.events = changes.events.slice(0, MAX_CHANGE_EVENTS);
      changes.schemaVersion = SCHEMA_VERSION;
      await writeFile(CHANGES_FILE, JSON.stringify(changes, null, 2) + '\n');
      log(`recorded index change: +${added.length} / -${removed.length}`);
    }
  }

  const holdingsDoc = {
    schemaVersion: SCHEMA_VERSION,
    fund: 'QQQ',
    name: 'Invesco QQQ Trust (Nasdaq-100 Index)',
    legacyTicker: 'QQQQ',
    asOf: now.toISOString(),
    source,
    count: holdings.length,
    totalWeight: +holdings.reduce((s, h) => s + h.weight, 0).toFixed(2),
    holdings,
  };
  validateHoldingsDocument(holdingsDoc);
  await writeFile(HOLDINGS_FILE, JSON.stringify(holdingsDoc, null, 2) + '\n');
  log('wrote', path.relative(ROOT, HOLDINGS_FILE));

  const mk = monthKey(now);
  const monthly = await readJson(MONTHLY_FILE);
  const updated = applyMonthlySnapshot(monthly, holdings, mk, MAX_MONTHS);
  updated.schemaVersion = SCHEMA_VERSION;
  updated.updatedAt = now.toISOString();
  validateMonthlyDocument(updated);
  await writeFile(MONTHLY_FILE, JSON.stringify(updated, null, 2) + '\n');
  log('wrote', path.relative(ROOT, MONTHLY_FILE), `(${mk} snapshot)`);

  const qqq = quotes.QQQ;
  if (qqq && Number.isFinite(qqq.price)) {
    const prevHistory = await readJson(PRICE_HISTORY_FILE);
    const history = applyPriceSnapshot(
      prevHistory?.history, now.toISOString().slice(0, 10), qqq.price, MAX_PRICE_DAYS
    );
    const priceDoc = {
      schemaVersion: SCHEMA_VERSION,
      fund: 'QQQ',
      updatedAt: now.toISOString(),
      history,
    };
    await writeFile(PRICE_HISTORY_FILE, JSON.stringify(priceDoc, null, 2) + '\n');
    log('wrote', path.relative(ROOT, PRICE_HISTORY_FILE), `(${history.length} days)`);
  } else {
    log('no QQQ quote — skipping price-history update');
  }

  const fellBack = isFallbackSource(source);
  const status = buildRefreshStatus({
    runAt: now.toISOString(),
    holdingsSource: source,
    quoteSource,
    holdingsCount: holdings.length,
    pricedCount: priced,
    totalWeight: holdings.reduce((s, h) => s + h.weight, 0),
    unmappedCount: unmapped.length,
    unmappedSample: unmapped.map((u) => u.name),
    attempts,
    fallback: fellBack,
  });
  validateRefreshStatus(status);
  await writeFile(REFRESH_STATUS_FILE, JSON.stringify(status, null, 2) + '\n');
  log('wrote', path.relative(ROOT, REFRESH_STATUS_FILE));

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
