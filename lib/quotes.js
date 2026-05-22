// Live quote fetching, shared by scripts/fetch-holdings.js and server.js.
// Uses Financial Modeling Prep when an API key is available (one batched
// request), otherwise falls back to the Yahoo Finance chart API.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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

async function fetchFmpQuotes(tickers, apiKey) {
  const out = {};
  const headers = { 'User-Agent': UA, apikey: apiKey };
  for (let i = 0; i < tickers.length; i += 100) {
    const chunk = tickers.slice(i, i + 100);
    const key = encodeURIComponent(apiKey);
    const symbols = chunk.map(encodeURIComponent).join(',');

    // Stable quote API first; fall back to legacy v3 for older keys.
    let url =
      `https://financialmodelingprep.com/stable/quote?symbol=${symbols}&apikey=${key}`;
    let res = await fetch(url, { headers });
    if (!res.ok) {
      url =
        `https://financialmodelingprep.com/api/v3/quote/${symbols}?apikey=${key}`;
      res = await fetch(url, { headers });
      if (!res.ok) return null;
    }
    const arr = await res.json();
    if (!Array.isArray(arr)) return null;
    for (const q of arr) {
      const price = Number(q.price);
      if (!q.symbol || !Number.isFinite(price)) continue;
      const raw = q.changesPercentage;
      const chg = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(/[%+\s]/g, ''));
      const quote = {
        price: +price.toFixed(2),
        changePct: Number.isFinite(chg) ? +chg.toFixed(2) : null,
      };
      // Per-component fundamentals, when the source provides them.
      const mc = Number(q.marketCap), pe = Number(q.pe);
      const yh = Number(q.yearHigh), yl = Number(q.yearLow);
      if (Number.isFinite(mc) && mc > 0) quote.marketCap = Math.round(mc);
      if (Number.isFinite(pe)) quote.pe = +pe.toFixed(2);
      if (Number.isFinite(yh) && yh > 0) quote.yearHigh = +yh.toFixed(2);
      if (Number.isFinite(yl) && yl > 0) quote.yearLow = +yl.toFixed(2);
      out[String(q.symbol).toUpperCase()] = quote;
    }
  }
  return Object.keys(out).length ? out : null;
}

async function fetchYahooQuote(ticker) {
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
    const quote = {
      price: +price.toFixed(2),
      changePct:
        Number.isFinite(prev) && prev ? +(((price - prev) / prev) * 100).toFixed(2) : null,
    };
    // The chart endpoint exposes a 52-week range but no market cap / P/E.
    const yh = Number(meta.fiftyTwoWeekHigh), yl = Number(meta.fiftyTwoWeekLow);
    if (Number.isFinite(yh) && yh > 0) quote.yearHigh = +yh.toFixed(2);
    if (Number.isFinite(yl) && yl > 0) quote.yearLow = +yl.toFixed(2);
    return quote;
  } catch {
    return null;
  }
}

async function fetchYahooQuotes(tickers) {
  const results = await mapLimit(tickers, 6, fetchYahooQuote);
  const out = {};
  tickers.forEach((t, i) => {
    if (results[i]) out[t] = results[i];
  });
  return out;
}

/**
 * Fetch quotes for a list of tickers.
 * @returns {Promise<{source: string, quotes: Object<string,{price:number,changePct:number|null}>}>}
 */
export async function fetchQuotes(tickers, { fmpKey } = {}) {
  if (fmpKey) {
    try {
      const quotes = await fetchFmpQuotes(tickers, fmpKey);
      if (quotes) return { source: 'fmp', quotes };
    } catch {
      /* fall through to Yahoo */
    }
  }
  return { source: 'yahoo', quotes: await fetchYahooQuotes(tickers) };
}
