// Unit tests for the data pipeline. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCsv,
  parseInvescoCsv,
  parseFmpHoldings,
  parseSecNportHoldings,
  buildNameTickerMap,
  buildRefreshStatus,
  validateHoldings,
  validateHoldingsDocument,
  validateMonthlyDocument,
  validateRefreshStatus,
  lookupTickerByName,
  diffConstituents,
  monthKey,
  applyMonthlySnapshot,
  applyPriceSnapshot,
  isFallbackSource,
  MIN_HOLDINGS,
} from '../lib/holdings.js';

/** Build N synthetic holdings whose weights sum to 100. */
function makeHoldings(n) {
  return Array.from({ length: n }, (_, i) => ({
    ticker: 'T' + i,
    name: 'Company ' + i,
    sector: 'Technology',
    weight: +(100 / n).toFixed(4),
    price: null,
    changePct: null,
  }));
}

test('parseCsv handles quotes, embedded commas and "" escapes', () => {
  const rows = parseCsv('a,b,c\n"x,y","he said ""hi""",z\n');
  assert.deepEqual(rows, [
    ['a', 'b', 'c'],
    ['x,y', 'he said "hi"', 'z'],
  ]);
});

test('parseCsv handles a newline inside a quoted field', () => {
  const rows = parseCsv('name,note\n"Acme","line1\nline2"');
  assert.equal(rows.length, 2);
  assert.equal(rows[1][1], 'line1\nline2');
});

test('parseInvescoCsv extracts holdings and skips cash rows', () => {
  const csv =
    'Fund Ticker,Holding Ticker,Name,Weight,Sector\n' +
    'QQQ,AAPL,Apple Inc,8.50,Technology\n' +
    'QQQ,MSFT,Microsoft Corp,7.90,Technology\n' +
    'QQQ,USD,Cash,0.10,--\n';
  const holdings = parseInvescoCsv(csv);
  assert.equal(holdings.length, 2);
  assert.equal(holdings[0].ticker, 'AAPL');
  assert.equal(holdings[0].weight, 8.5);
  assert.equal(holdings[1].sector, 'Technology');
});

test('parseInvescoCsv throws when required columns are missing', () => {
  assert.throws(() => parseInvescoCsv('foo,bar\n1,2\n3,4\n5,6\n7,8\n9,10\n11,12\n13,14\n15,16\n17,18\n'));
});

test('parseInvescoCsv rejects HTML responses', () => {
  assert.throws(() => parseInvescoCsv('<!DOCTYPE html><html></html>'), /HTML/);
});

test('parseInvescoCsv finds the header row after preamble lines', () => {
  const csv =
    'Invesco QQQ Trust\n' +
    'As of date\n' +
    'Fund Ticker,Holding Ticker,Name,Weight,Sector\n' +
    'QQQ,NVDA,NVIDIA Corp,9.6,Technology\n' +
    'QQQ,AAPL,Apple Inc,8.1,Technology\n';
  const holdings = parseInvescoCsv(csv);
  assert.equal(holdings.length, 2);
  assert.equal(holdings[0].ticker, 'NVDA');
});

test('parseFmpHoldings maps the etf-holder shape', () => {
  const holdings = parseFmpHoldings([
    { asset: 'AAPL', name: 'Apple Inc', weightPercentage: 8.5 },
    { asset: 'MSFT', name: 'Microsoft Corp', weightPercentage: 7.9 },
    { asset: '', name: 'bad row', weightPercentage: 1 },
  ]);
  assert.equal(holdings.length, 2);
  assert.equal(holdings[0].ticker, 'AAPL');
});

test('parseFmpHoldings maps the stable etf/holdings shape', () => {
  const holdings = parseFmpHoldings({
    holdings: [
      { symbol: 'NVDA', name: 'NVIDIA Corp', weight: 9.6, sector: 'Technology' },
      { symbol: 'AAPL', name: 'Apple Inc', weight: 8.1 },
    ],
  });
  assert.equal(holdings.length, 2);
  assert.equal(holdings[0].ticker, 'NVDA');
  assert.equal(holdings[0].sector, 'Technology');
});

test('validateHoldings accepts a well-formed snapshot', () => {
  const h = makeHoldings(100);
  assert.equal(validateHoldings(h), h);
});

test('validateHoldings rejects too few holdings', () => {
  assert.throws(() => validateHoldings(makeHoldings(MIN_HOLDINGS - 1)), /at least/);
});

test('validateHoldings rejects too many holdings', () => {
  assert.throws(() => validateHoldings(makeHoldings(200)), /at most/);
});

test('validateHoldings rejects a weight sum far from 100%', () => {
  const h = makeHoldings(100);
  h[0].weight = 60; // pushes the total well past 110%
  assert.throws(() => validateHoldings(h), /weights sum/);
});

test('validateHoldings rejects duplicate tickers', () => {
  const h = makeHoldings(100);
  h[1].ticker = h[0].ticker;
  assert.throws(() => validateHoldings(h), /duplicate/);
});

test('validateHoldings rejects an invalid weight', () => {
  const h = makeHoldings(100);
  h[5].weight = 0;
  assert.throws(() => validateHoldings(h), /invalid weight/);
});

test('diffConstituents reports additions and removals', () => {
  const prev = [{ ticker: 'A', name: 'A' }, { ticker: 'B', name: 'B' }];
  const next = [{ ticker: 'B', name: 'B' }, { ticker: 'C', name: 'C' }];
  const { added, removed } = diffConstituents(prev, next);
  assert.deepEqual(added, [{ ticker: 'C', name: 'C' }]);
  assert.deepEqual(removed, [{ ticker: 'A', name: 'A' }]);
});

test('diffConstituents reports nothing when membership is unchanged', () => {
  const same = [{ ticker: 'A', name: 'A' }];
  const { added, removed } = diffConstituents(same, same);
  assert.equal(added.length, 0);
  assert.equal(removed.length, 0);
});

test('monthKey formats a UTC year-month', () => {
  assert.equal(monthKey(new Date('2026-03-09T12:00:00Z')), '2026-03');
  assert.equal(monthKey(new Date('2026-11-30T23:59:00Z')), '2026-11');
});

test('applyMonthlySnapshot records the current month without mutating input', () => {
  const monthly = { fund: 'QQQ', months: ['2026-01'], allocations: { AAPL: { '2026-01': 8.0 } } };
  const out = applyMonthlySnapshot(monthly, [{ ticker: 'AAPL', weight: 8.4 }], '2026-02', 24);
  assert.deepEqual(out.months, ['2026-01', '2026-02']);
  assert.equal(out.allocations.AAPL['2026-02'], 8.4);
  assert.equal(out.allocations.AAPL['2026-01'], 8.0);
  assert.equal(monthly.months.length, 1, 'input must not be mutated');
});

test('applyMonthlySnapshot prunes history beyond maxMonths', () => {
  const monthly = {
    months: ['2026-01', '2026-02', '2026-03'],
    allocations: { AAPL: { '2026-01': 1, '2026-02': 2, '2026-03': 3 } },
  };
  const out = applyMonthlySnapshot(monthly, [{ ticker: 'AAPL', weight: 4 }], '2026-04', 2);
  assert.deepEqual(out.months, ['2026-03', '2026-04']);
  assert.deepEqual(Object.keys(out.allocations.AAPL).sort(), ['2026-03', '2026-04']);
});

test('applyMonthlySnapshot updates the current month on a same-month re-run', () => {
  const monthly = {
    months: ['2026-05'],
    allocations: { AAPL: { '2026-05': 8.0 } },
  };
  const out = applyMonthlySnapshot(monthly, [{ ticker: 'AAPL', weight: 8.4 }], '2026-05', 24);
  assert.deepEqual(out.months, ['2026-05']);
  assert.equal(out.allocations.AAPL['2026-05'], 8.4);
});

test('parseSecNportHoldings maps SEC names to tickers via a prior snapshot', () => {
  const nameMap = buildNameTickerMap([
    { ticker: 'NVDA', name: 'NVIDIA Corp' },
    { ticker: 'AAPL', name: 'Apple Inc' },
  ]);
  const xml = `
    <invstOrSec>
      <name>NVIDIA Corp.</name><pctVal>9.500</pctVal><assetCat>EC</assetCat>
    </invstOrSec>
    <invstOrSec>
      <name>Apple Inc.</name><pctVal>8.100</pctVal><assetCat>EC</assetCat>
    </invstOrSec>`;
  assert.throws(() => parseSecNportHoldings(xml, nameMap), /mapped only 2/);
});

test('buildRefreshStatus records quote success rate and attempts', () => {
  const status = buildRefreshStatus({
    runAt: '2026-05-22T12:00:00.000Z',
    holdingsSource: 'fmp',
    quoteSource: 'yahoo',
    holdingsCount: 100,
    pricedCount: 95,
    attempts: [{ source: 'fmp', ok: true, count: 100 }],
    fallback: false,
  });
  assert.equal(status.quoteSuccessRate, 0.95);
  assert.equal(status.holdingsSource, 'fmp');
  assert.equal(status.attempts.length, 1);
});

test('isFallbackSource flags cached and seed sources but not live ones', () => {
  assert.equal(isFallbackSource('invesco'), false);
  assert.equal(isFallbackSource('fmp'), false);
  assert.equal(isFallbackSource('sec-nport'), false);
  assert.equal(isFallbackSource('invesco-cached'), true);
  assert.equal(isFallbackSource('fmp-cached'), true);
  assert.equal(isFallbackSource('seed'), true);
});

test('applyPriceSnapshot records a new day and keeps history sorted', () => {
  const out = applyPriceSnapshot(
    [{ date: '2026-05-21', close: 480 }], '2026-05-22', 485, 180
  );
  assert.deepEqual(out, [
    { date: '2026-05-21', close: 480 },
    { date: '2026-05-22', close: 485 },
  ]);
});

test('applyPriceSnapshot is idempotent for a same-day re-run', () => {
  const history = [{ date: '2026-05-22', close: 480 }];
  const out = applyPriceSnapshot(history, '2026-05-22', 491, 180);
  assert.deepEqual(out, [{ date: '2026-05-22', close: 491 }]);
});

test('applyPriceSnapshot prunes to the most recent maxDays entries', () => {
  const history = [
    { date: '2026-05-19', close: 1 },
    { date: '2026-05-20', close: 2 },
    { date: '2026-05-21', close: 3 },
  ];
  const out = applyPriceSnapshot(history, '2026-05-22', 4, 2);
  assert.deepEqual(out, [
    { date: '2026-05-21', close: 3 },
    { date: '2026-05-22', close: 4 },
  ]);
});

test('applyPriceSnapshot ignores a non-finite close', () => {
  const history = [{ date: '2026-05-21', close: 480 }];
  assert.deepEqual(applyPriceSnapshot(history, '2026-05-22', null, 180), history);
});

test('lookupTickerByName resolves partial and token-overlap names', () => {
  const map = buildNameTickerMap([
    { ticker: 'MSFT', name: 'Microsoft Corp.' },
    { ticker: 'AAPL', name: 'Apple Inc.' },
  ]);
  assert.equal(lookupTickerByName('Microsoft Corporation', map), 'MSFT');
  assert.equal(lookupTickerByName('Apple Inc', map), 'AAPL');
  assert.equal(lookupTickerByName('Totally Unknown Co', map), null);
});

test('validateHoldingsDocument accepts a well-formed snapshot', () => {
  const doc = {
    schemaVersion: 1,
    fund: 'QQQ',
    asOf: '2026-05-22T00:00:00.000Z',
    source: 'sec-nport',
    holdings: makeHoldings(80),
  };
  assert.equal(validateHoldingsDocument(doc).fund, 'QQQ');
});

test('validateHoldingsDocument rejects wrong schemaVersion', () => {
  assert.throws(
    () => validateHoldingsDocument({ schemaVersion: 2, fund: 'QQQ', asOf: 'x', source: 'seed', holdings: makeHoldings(10) }),
    /schemaVersion/
  );
});

test('validateMonthlyDocument accepts months and allocations', () => {
  const doc = {
    schemaVersion: 1,
    fund: 'QQQ',
    months: ['2026-05'],
    allocations: { AAPL: { '2026-05': 8.1 } },
  };
  assert.equal(validateMonthlyDocument(doc).months.length, 1);
});

test('validateRefreshStatus requires pipeline summary fields', () => {
  const doc = {
    schemaVersion: 1,
    runAt: '2026-05-22T00:00:00.000Z',
    holdingsSource: 'sec-nport',
    quoteSource: 'yahoo',
    quoteSuccessRate: 0.98,
  };
  assert.equal(validateRefreshStatus(doc).quoteSource, 'yahoo');
  assert.throws(() => validateRefreshStatus({ schemaVersion: 1 }), /missing run summary/);
});
