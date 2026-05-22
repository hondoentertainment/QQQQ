// Pure data-pipeline helpers for the QQQQ tracker — no network, no I/O — so
// they can be unit-tested. Used by scripts/fetch-holdings.js.

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
  const rows = parseCsv(text).filter((r) => r.some((c) => c && c.trim()));
  // Structural check only — the real count is enforced by validateHoldings.
  if (rows.length < 2) throw new Error('Invesco CSV has no data rows');

  const header = rows[0].map((h) => h.trim().toLowerCase());
  // Match keys in priority order so e.g. "Holding Ticker" wins over "Fund Ticker".
  const col = (...keys) => {
    for (const k of keys) {
      const idx = header.findIndex((h) => h.includes(k));
      if (idx >= 0) return idx;
    }
    return -1;
  };
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
  return holdings;
}

/** Parse a Financial Modeling Prep etf-holder response into holding records. */
export function parseFmpHoldings(arr) {
  if (!Array.isArray(arr)) throw new Error('FMP response is not an array');
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
  return holdings;
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
