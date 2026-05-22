// Pure data-pipeline helpers for the QQQQ tracker — no network, no I/O — so
// they can be unit-tested. Used by scripts/fetch-holdings.js.

// Bumped when the on-disk shape of any data/*.json file changes. Each written
// document is stamped with it so a future reader can detect a mismatch.
export const SCHEMA_VERSION = 1;

// A QQQ snapshot is the ~100 Nasdaq-100 constituents; reject anything wildly off.
export const MIN_HOLDINGS = 80;
export const MAX_HOLDINGS = 130;

/** RFC-4180-ish CSV parser: handles quotes, embedded commas/newlines, "" escapes. */
export function parseCsv(text) {
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

/** Parse an Invesco QQQ holdings CSV into holding records. */
export function parseInvescoCsv(text) {
  if (String(text).trimStart().startsWith('<')) {
    throw new Error('Invesco response is HTML, not CSV');
  }
  const rows = parseCsv(text).filter((r) => r.some((c) => c && c.trim()));
  if (rows.length < 2) throw new Error('Invesco CSV has no data rows');

  const headerIdx = findCsvHeaderRow(rows);
  const header = rows[headerIdx].map((h) => h.trim().toLowerCase());
  const col = (...keys) => {
    for (const k of keys) {
      const idx = header.findIndex((h) => h.includes(k));
      if (idx >= 0) return idx;
    }
    return -1;
  };
  const iTicker = col('holding ticker', 'ticker', 'symbol', 'stock ticker');
  const iName = col('name', 'holding name', 'security name', 'company');
  const iWeight = col(
    'weight', 'percentageoffund', 'percent', '% of net assets',
    'net assets', 'portfolio weight', 'weightings'
  );
  const iSector = col('sector', 'gics sector');
  if (iTicker < 0 || iWeight < 0) {
    throw new Error('Invesco CSV columns not recognised');
  }

  const holdings = [];
  for (const r of rows.slice(headerIdx + 1)) {
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
  return holdings;
}

/** Scan the first rows of a CSV for a plausible holdings header line. */
function findCsvHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const header = rows[i].map((h) => h.trim().toLowerCase());
    const hasTicker = header.some((h) =>
      h.includes('ticker') || h.includes('symbol')
    );
    const hasWeight = header.some((h) =>
      h.includes('weight') || h.includes('percent') || h.includes('net assets')
    );
    if (hasTicker && hasWeight) return i;
  }
  return 0;
}

/** Parse a Financial Modeling Prep etf-holder / stable holdings response. */
export function parseFmpHoldings(arr) {
  const rows = Array.isArray(arr)
    ? arr
    : Array.isArray(arr?.holdings)
      ? arr.holdings
      : null;
  if (!rows) throw new Error('FMP response is not an array');
  const holdings = [];
  for (const r of rows) {
    const ticker = String(r.asset || r.symbol || r.ticker || '').trim().toUpperCase();
    const weight = Number(
      r.weightPercentage ?? r.weight ?? r.percentage ?? r.percentOfPortfolio
    );
    if (!ticker || !Number.isFinite(weight) || weight <= 0) continue;
    holdings.push({
      ticker,
      name: String(r.name || r.assetName || ticker).trim(),
      sector: String(r.sector || r.sectorName || '').trim() || 'Unclassified',
      weight: +weight.toFixed(3),
      price: null,
      changePct: null,
    });
  }
  return holdings;
}

/** Normalize a company name for cross-source ticker matching. */
export function normalizeCompanyName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[.,']/g, '')
    .replace(/\b(inc|corp|corporation|ltd|plc|co|company|adr|sa|se|ag|the)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Build a normalized company-name → ticker map from a prior snapshot and overrides. */
export function buildNameTickerMap(holdings, overrides = {}) {
  const map = new Map();
  for (const h of holdings || []) {
    if (h?.ticker && h?.name) map.set(normalizeCompanyName(h.name), h.ticker);
  }
  for (const [name, ticker] of Object.entries(overrides || {})) {
    if (name && ticker) map.set(normalizeCompanyName(name), String(ticker).toUpperCase());
  }
  return map;
}

/** Resolve a company name to a ticker using a prior name map. */
export function lookupTickerByName(name, nameToTicker) {
  if (!name) return null;
  const norm = normalizeCompanyName(name);
  if (nameToTicker.has(norm)) return nameToTicker.get(norm);

  for (const [key, ticker] of nameToTicker) {
    if (norm.includes(key) || key.includes(norm)) return ticker;
  }

  const words = norm.split(' ').filter((w) => w.length > 2);
  let best = null;
  let bestScore = 0;
  for (const [key, ticker] of nameToTicker) {
    const keyWords = key.split(' ').filter(Boolean);
    const score = words.filter((w) =>
      keyWords.some((kw) => kw.startsWith(w) || w.startsWith(kw))
    ).length;
    if (score > bestScore) {
      bestScore = score;
      best = ticker;
    }
  }
  return bestScore >= 2 ? best : null;
}

/**
 * Parse an SEC N-PORT primary_doc.xml into holdings. Tickers are resolved via
 * `nameToTicker`, typically built from the last good snapshot plus overrides.
 * Returns `{ holdings, unmapped }` where unmapped lists SEC names with no ticker.
 */
export function parseSecNportHoldings(xml, nameToTicker = new Map()) {
  const holdings = [];
  const unmapped = [];
  const seen = new Set();
  for (const m of String(xml).matchAll(/<invstOrSec>([\s\S]*?)<\/invstOrSec>/g)) {
    const block = m[1];
    const name = block.match(/<name>([^<]+)/)?.[1]?.trim();
    const title = block.match(/<title>([^<]+)/)?.[1]?.trim();
    const pct = parseFloat(block.match(/<pctVal>([^<]+)/)?.[1]);
    const assetCat = block.match(/<assetCat>([^<]+)/)?.[1];
    const label = name || title;
    if ((!name && !title) || !Number.isFinite(pct) || pct <= 0) continue;
    if (assetCat === 'STIV' || assetCat === 'DBT' || assetCat === 'RA') continue;
    const ticker =
      lookupTickerByName(name, nameToTicker) ||
      lookupTickerByName(title, nameToTicker);
    if (!ticker) {
      unmapped.push({ name: label, weight: +pct.toFixed(3) });
      continue;
    }
    if (seen.has(ticker)) continue;
    seen.add(ticker);
    holdings.push({
      ticker,
      name: label || ticker,
      sector: 'Unclassified',
      weight: +pct.toFixed(3),
      price: null,
      changePct: null,
    });
  }
  if (holdings.length < MIN_HOLDINGS) {
    throw new Error(`SEC N-PORT: mapped only ${holdings.length} holdings`);
  }
  return { holdings, unmapped };
}

/** Structured summary written to data/refresh-status.json after each run. */
export function buildRefreshStatus({
  runAt,
  holdingsSource,
  quoteSource,
  holdingsCount,
  pricedCount,
  totalWeight,
  unmappedCount = 0,
  unmappedSample = [],
  attempts = [],
  fallback = false,
}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    runAt,
    holdingsSource,
    quoteSource,
    holdingsCount,
    pricedCount,
    totalWeight: Number.isFinite(totalWeight) ? +totalWeight.toFixed(2) : null,
    unmappedCount,
    unmappedSample: unmappedSample.slice(0, 8),
    quoteSuccessRate: holdingsCount
      ? +((pricedCount / holdingsCount).toFixed(4))
      : 0,
    fallback,
    attempts,
  };
}

/**
 * Throw if a holdings array looks malformed, so a bad source can't silently
 * corrupt the committed data. Returns the holdings unchanged when valid.
 */
export function validateHoldings(holdings, label = 'source') {
  const n = Array.isArray(holdings) ? holdings.length : 0;
  if (n < MIN_HOLDINGS) {
    throw new Error(`${label}: ${n} holdings (expected at least ${MIN_HOLDINGS})`);
  }
  if (n > MAX_HOLDINGS) {
    throw new Error(`${label}: ${n} holdings (expected at most ${MAX_HOLDINGS})`);
  }
  const seen = new Set();
  for (const h of holdings) {
    if (!h || !h.ticker || typeof h.ticker !== 'string') {
      throw new Error(`${label}: holding with missing ticker`);
    }
    if (!Number.isFinite(h.weight) || h.weight <= 0) {
      throw new Error(`${label}: ${h.ticker} has invalid weight ${h.weight}`);
    }
    if (seen.has(h.ticker)) throw new Error(`${label}: duplicate ticker ${h.ticker}`);
    seen.add(h.ticker);
  }
  const total = holdings.reduce((s, h) => s + h.weight, 0);
  if (!(total > 90 && total < 110)) {
    throw new Error(`${label}: weights sum to ${total.toFixed(1)}% (expected ~100%)`);
  }
  return holdings;
}

/** Validate a holdings.json document before it is committed. */
export function validateHoldingsDocument(doc, label = 'holdings.json') {
  if (!doc || typeof doc !== 'object') {
    throw new Error(`${label}: document is missing`);
  }
  if (doc.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`${label}: schemaVersion ${doc.schemaVersion} != ${SCHEMA_VERSION}`);
  }
  if (doc.fund !== 'QQQ' || !doc.asOf || !doc.source) {
    throw new Error(`${label}: missing fund/asOf/source`);
  }
  validateHoldings(doc.holdings, label);
  return doc;
}

/** Validate a monthly-allocations.json document before it is committed. */
export function validateMonthlyDocument(doc, label = 'monthly-allocations.json') {
  if (!doc || typeof doc !== 'object') {
    throw new Error(`${label}: document is missing`);
  }
  if (doc.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`${label}: schemaVersion ${doc.schemaVersion} != ${SCHEMA_VERSION}`);
  }
  if (!Array.isArray(doc.months) || !doc.allocations) {
    throw new Error(`${label}: missing months or allocations`);
  }
  return doc;
}

/** Validate refresh-status.json before it is committed. */
export function validateRefreshStatus(doc, label = 'refresh-status.json') {
  if (!doc || typeof doc !== 'object') {
    throw new Error(`${label}: document is missing`);
  }
  if (doc.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`${label}: schemaVersion ${doc.schemaVersion} != ${SCHEMA_VERSION}`);
  }
  if (!doc.runAt || !doc.holdingsSource || !doc.quoteSource) {
    throw new Error(`${label}: missing run summary fields`);
  }
  if (!Number.isFinite(doc.quoteSuccessRate)) {
    throw new Error(`${label}: quoteSuccessRate is invalid`);
  }
  return doc;
}

/** Constituents added to / removed from the index between two snapshots. */
export function diffConstituents(prevHoldings, nextHoldings) {
  const prev = new Set((prevHoldings || []).map((h) => h.ticker));
  const next = new Set((nextHoldings || []).map((h) => h.ticker));
  return {
    added: (nextHoldings || [])
      .filter((h) => !prev.has(h.ticker))
      .map((h) => ({ ticker: h.ticker, name: h.name })),
    removed: (prevHoldings || [])
      .filter((h) => !next.has(h.ticker))
      .map((h) => ({ ticker: h.ticker, name: h.name })),
  };
}

export function monthKey(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Return a new monthly-allocations document with the current month's weights
 * recorded, keeping at most `maxMonths` of history.
 */
export function applyMonthlySnapshot(monthly, holdings, mk, maxMonths = 24) {
  const months = Array.isArray(monthly?.months) ? [...monthly.months] : [];
  if (!months.includes(mk)) months.push(mk);
  months.sort();
  const kept = months.slice(-maxMonths);
  const keep = new Set(kept);

  const allocations = {};
  for (const [ticker, rec] of Object.entries(monthly?.allocations || {})) {
    allocations[ticker] = {};
    for (const [m, w] of Object.entries(rec)) {
      if (keep.has(m)) allocations[ticker][m] = w;
    }
  }
  for (const h of holdings) {
    allocations[h.ticker] = allocations[h.ticker] || {};
    allocations[h.ticker][mk] = h.weight;
  }
  return { fund: monthly?.fund || 'QQQ', months: kept, allocations };
}

/**
 * True when a refresh `source` means no live holdings provider could be
 * reached and the run is serving cached or seed data. The refresh job uses
 * this to alert when the dashboard may be silently stale.
 */
export function isFallbackSource(source) {
  return source !== 'invesco' && source !== 'fmp' && source !== 'sec-nport';
}

/**
 * Return a new fund price-history array with `close` recorded for `dateKey`
 * (a YYYY-MM-DD string), replacing any existing entry for that day. The result
 * is sorted oldest-first and pruned to the most recent `maxDays` entries, so
 * re-running on the same day is idempotent.
 */
export function applyPriceSnapshot(history, dateKey, close, maxDays = 180) {
  const byDate = new Map();
  for (const e of Array.isArray(history) ? history : []) {
    if (e && typeof e.date === 'string' && Number.isFinite(e.close)) {
      byDate.set(e.date, e.close);
    }
  }
  if (typeof dateKey === 'string' && Number.isFinite(close)) {
    byDate.set(dateKey, close);
  }
  return [...byDate.entries()]
    .map(([date, c]) => ({ date, close: c }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .slice(-maxDays);
}
