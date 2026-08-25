#!/usr/bin/env node
// Refreshes data/holdings.json, data/monthly-allocations.json and data/changes.json.
//
// Holdings + weights (live, never fabricated):
//   Invesco DNG JSON → Invesco legacy CSV → Slickcharts → FMP (if keyed) →
//   SEC N-PORT filing → last good / seed.
// Nasdaq's list-type API is used only to resolve SEC names to tickers.
// Prices: see lib/quotes.js.
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchQuotes } from '../lib/quotes.js';
import {
  parseInvescoCsv,
  parseInvescoDngJson,
  parseFmpHoldings,
  parseSlickchartsHtml,
  parseSecNportHoldings,
  parseNasdaqConstituents,
  validateHoldings,
  diffConstituents,
  monthKey,
  applyMonthlySnapshot,
  applyPriceSnapshot,
  isFallbackSource,
  buildNameTickerMap,
  normalizeCompanyName,
  SCHEMA_VERSION,
} from '../lib/holdings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOLDINGS_FILE = path.join(ROOT, 'data', 'holdings.json');
const MONTHLY_FILE = path.join(ROOT, 'data', 'monthly-allocations.json');
const CHANGES_FILE = path.join(ROOT, 'data', 'changes.json');
const PRICE_HISTORY_FILE = path.join(ROOT, 'data', 'price-history.json');
const NAME_OVERRIDES_FILE = path.join(ROOT, 'data', 'name-overrides.json');
const MAX_MONTHS = 24;
const MAX_CHANGE_EVENTS = 50;
const MAX_PRICE_DAYS = 180;
const SEC_CIK = '1067839';
// Per-component fundamentals carried over from the quote source onto holdings.
const FUNDAMENTAL_FIELDS = ['marketCap', 'pe', 'yearHigh', 'yearLow'];
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const SEC_UA = 'QQQQ-Tracker (https://github.com/hondoentertainment/QQQQ)';
const INVESCO_REFERER = 'https://www.invesco.com/qqq-etf/en/about.html';

const log = (...a) => console.log('[refresh]', ...a);

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function fetchJsonOrText(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if (ctype.includes('json')) return { kind: 'json', body: await res.json() };
  const text = await res.text();
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return { kind: 'json', body: JSON.parse(text) }; } catch { /* fall through */ }
  }
  return { kind: 'text', body: text };
}

async function fetchInvescoHoldings() {
  const headers = {
    'User-Agent': UA,
    Accept: 'application/json,text/csv,text/plain,*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: INVESCO_REFERER,
    Origin: 'https://www.invesco.com',
  };
  const attempts = [
    {
      label: 'DNG',
      url: 'https://dng-api.invesco.com/cache/v1/accounts/en_US/shareclasses/QQQ'
        + '/holdings/fund?idType=ticker&interval=monthly&productType=ETF',
      parse: (got) => {
        if (got.kind !== 'json') throw new Error('DNG response is not JSON');
        return parseInvescoDngJson(got.body);
      },
    },
    {
      label: 'DNG-CUSIP',
      url: 'https://dng-api.invesco.com/cache/v1/accounts/en_US/shareclasses/46090E103'
        + '/holdings/fund?idType=cusip&productType=ETF',
      parse: (got) => {
        if (got.kind !== 'json') throw new Error('DNG response is not JSON');
        return parseInvescoDngJson(got.body);
      },
    },
    {
      label: 'CSV',
      url: 'https://www.invesco.com/us/financial-products/etfs/holdings/main/holdings/0'
        + '?audienceType=Investor&action=download&ticker=QQQ',
      parse: (got) => {
        if (got.kind === 'json') return parseInvescoDngJson(got.body);
        if (String(got.body).trimStart().startsWith('<')) {
          throw new Error('CSV endpoint returned HTML');
        }
        return parseInvescoCsv(got.body);
      },
    },
  ];
  const errors = [];
  for (const attempt of attempts) {
    try {
      const got = await fetchJsonOrText(attempt.url, headers);
      return validateHoldings(attempt.parse(got), 'Invesco');
    } catch (err) {
      errors.push(`${attempt.label}: ${err.message}`);
    }
  }
  throw new Error(errors.join('; '));
}

async function fetchSlickchartsHoldings() {
  const url = 'https://www.slickcharts.com/nasdaq100';
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
  });
  if (!res.ok) throw new Error('Slickcharts HTTP ' + res.status);
  return validateHoldings(parseSlickchartsHtml(await res.text()), 'Slickcharts');
}

async function fetchFmpHoldings(apiKey) {
  const url =
    `https://financialmodelingprep.com/api/v3/etf-holder/QQQ?apikey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('FMP HTTP ' + res.status);
  return validateHoldings(parseFmpHoldings(await res.json()), 'FMP');
}

async function fetchNasdaqNameMap() {
  const url = 'https://api.nasdaq.com/api/quote/list-type/nasdaq100';
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      Origin: 'https://www.nasdaq.com',
      Referer: 'https://www.nasdaq.com/',
    },
  });
  if (!res.ok) throw new Error('Nasdaq HTTP ' + res.status);
  return parseNasdaqConstituents(await res.json());
}

async function fetchSecHoldings(nameToTicker) {
  const headers = { 'User-Agent': SEC_UA, Accept: 'application/json' };
  const subRes = await fetch(
    `https://data.sec.gov/submissions/CIK000${SEC_CIK}.json`,
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
  const { holdings, unmapped } = parseSecNportHoldings(await xmlRes.text(), nameToTicker);
  if (unmapped.length) {
    log(`SEC N-PORT: ${unmapped.length} names could not be mapped`);
    unmapped.slice(0, 5).forEach((u) => log(`  unmapped: ${u.name} (${u.weight}%)`));
  }
  return { holdings: validateHoldings(holdings, 'SEC N-PORT'), unmapped };
}

const LIVE_SOURCES = new Set([
  'invesco', 'fmp', 'slickcharts', 'sec-nport',
  'invesco-cached', 'fmp-cached', 'slickcharts-cached', 'sec-nport-cached',
]);

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

  if (!holdings) {
    try {
      log('trying Slickcharts Nasdaq-100…');
      holdings = await fetchSlickchartsHoldings();
      source = 'slickcharts';
      log(`got ${holdings.length} holdings from Slickcharts`);
    } catch (err) {
      log('Slickcharts fetch failed:', err.message);
    }
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
    try {
      log('trying SEC N-PORT filing…');
      const overrides = (await readJson(NAME_OVERRIDES_FILE)) || {};
      const nameMap = buildNameTickerMap(prev?.holdings || [], overrides);
      try {
        const nasdaq = await fetchNasdaqNameMap();
        for (const row of nasdaq) {
          nameMap.set(normalizeCompanyName(row.name), row.ticker);
        }
        log(`merged ${nasdaq.length} Nasdaq names into the ticker map`);
      } catch (err) {
        log('Nasdaq name map unavailable:', err.message);
      }
      const sec = await fetchSecHoldings(nameMap);
      holdings = sec.holdings;
      source = 'sec-nport';
      log(`got ${holdings.length} holdings from SEC N-PORT`);
    } catch (err) {
      log('SEC N-PORT fetch failed:', err.message);
    }
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
  // Fetch QQQ itself alongside the components so the fund price-history can be
  // tracked from the same quote source.
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
      // Carry whichever fundamentals the source supplied; leave the rest unset.
      for (const f of FUNDAMENTAL_FIELDS) {
        if (Number.isFinite(q[f])) h[f] = q[f];
      }
      priced++;
    }
  }
  log(`priced ${priced}/${holdings.length} holdings via ${quoteSource}`);

  holdings.sort((a, b) => b.weight - a.weight);

  // Record constituent additions / removals between live snapshots.
  const liveNow = source === 'invesco' || source === 'fmp'
    || source === 'slickcharts' || source === 'sec-nport';
  if (prev?.holdings?.length && LIVE_SOURCES.has(prev.source) && liveNow) {
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
  await writeFile(HOLDINGS_FILE, JSON.stringify(holdingsDoc, null, 2) + '\n');
  log('wrote', path.relative(ROOT, HOLDINGS_FILE));

  const mk = monthKey(now);
  const monthly = await readJson(MONTHLY_FILE);
  const updated = applyMonthlySnapshot(monthly, holdings, mk, MAX_MONTHS);
  updated.schemaVersion = SCHEMA_VERSION;
  updated.updatedAt = now.toISOString();
  await writeFile(MONTHLY_FILE, JSON.stringify(updated, null, 2) + '\n');
  log('wrote', path.relative(ROOT, MONTHLY_FILE), `(${mk} snapshot)`);

  // Append today's QQQ close to the fund price history (idempotent per day).
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
