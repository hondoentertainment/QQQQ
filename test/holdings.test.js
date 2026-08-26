// Unit tests for the data pipeline. Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCsv,
  parseInvescoCsv,
  parseInvescoDngJson,
  parseFmpHoldings,
  parseSlickchartsHtml,
  parseSecNportHoldings,
  parseNasdaqConstituents,
  normalizeCompanyName,
  buildNameTickerMap,
  lookupTickerByName,
  validateHoldings,
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

test('parseFmpHoldings maps the etf-holder shape', () => {
  const holdings = parseFmpHoldings([
    { asset: 'AAPL', name: 'Apple Inc', weightPercentage: 8.5 },
    { asset: 'MSFT', name: 'Microsoft Corp', weightPercentage: 7.9 },
    { asset: '', name: 'bad row', weightPercentage: 1 },
  ]);
  assert.equal(holdings.length, 2);
  assert.equal(holdings[0].ticker, 'AAPL');
});


test('parseSlickchartsHtml extracts ticker, name and weight', () => {
  const html =
    '<table><tr><th>Company</th><th>Symbol</th><th>Weight</th></tr>' +
    '<tr><td>Apple Inc</td><td>AAPL</td><td>12.85%</td></tr>' +
    '<tr><td>Microsoft Corp</td><td>MSFT</td><td>11.20%</td></tr></table>';
  const holdings = parseSlickchartsHtml(html);
  assert.equal(holdings.length, 2);
  assert.equal(holdings[0].ticker, 'AAPL');
  assert.equal(holdings[0].name, 'Apple Inc');
  assert.equal(holdings[0].weight, 12.85);
  assert.equal(holdings[1].ticker, 'MSFT');
});

test('parseSlickchartsHtml throws on empty or unmatched HTML', () => {
  assert.throws(() => parseSlickchartsHtml(''), /no table/);
  assert.throws(() => parseSlickchartsHtml('<html></html>'), /no table/);
});

test('parseInvescoCsv rejects an HTML body (retired download URL)', () => {
  assert.throws(() => parseInvescoCsv('<!DOCTYPE html><html><body>nope</body></html>'), /HTML/);
});

test('parseInvescoDngJson reads the live DNG wrapper (cusip + holdings)', () => {
  const holdings = parseInvescoDngJson({
    cusip: 'QQQ',
    effectiveDate: '2026-08-24',
    totalNumberOfHoldings: 3,
    holdings: [
      { ticker: 'AAPL', issuerName: 'Apple Inc', percentageOfTotalNetAssets: 8.5 },
      { ticker: 'MSFT', issuerName: 'Microsoft Corp', percentageOfTotalNetAssets: 7.9 },
      { ticker: 'USD', issuerName: 'Cash', percentageOfTotalNetAssets: 0.1 },
    ],
  });
  assert.equal(holdings.length, 2);
  assert.equal(holdings[0].ticker, 'AAPL');
  assert.equal(holdings[0].weight, 8.5);
  assert.equal(holdings[1].name, 'Microsoft Corp');
});

test('parseInvescoDngJson unwraps a nested data payload', () => {
  const holdings = parseInvescoDngJson({
    data: { items: [{ symbol: 'NVDA', name: 'NVIDIA', weight: 9.6 }] },
  });
  assert.equal(holdings[0].ticker, 'NVDA');
  assert.equal(holdings[0].weight, 9.6);
});

test('parseInvescoDngJson throws when no holding rows exist', () => {
  assert.throws(() => parseInvescoDngJson({ ok: true }), /no holdings/);
});

test('normalizeCompanyName strips suffixes used by Nasdaq and SEC', () => {
  assert.equal(normalizeCompanyName('Apple Inc.'), 'apple');
  assert.equal(normalizeCompanyName('Alphabet Inc. Class A Common Stock'), 'alphabet class a');
  assert.equal(normalizeCompanyName('Walmart Inc. Common Stock'), 'walmart');
});

test('lookupTickerByName prefers exact then class-qualified titles', () => {
  const map = buildNameTickerMap(
    [{ ticker: 'AAPL', name: 'Apple Inc' }],
    { 'alphabet inc class a': 'GOOGL', 'alphabet inc class c': 'GOOG' }
  );
  assert.equal(lookupTickerByName('Apple Inc.', map), 'AAPL');
  assert.equal(lookupTickerByName('Alphabet Inc., Class A', map), 'GOOGL');
  assert.equal(lookupTickerByName('Alphabet Inc., Class C', map), 'GOOG');
});

test('parseNasdaqConstituents extracts ticker/name and ignores market cap', () => {
  const rows = parseNasdaqConstituents({
    data: { data: { rows: [
      { symbol: 'AAPL', companyName: 'Apple Inc. Common Stock', marketCap: '4,000,000' },
      { symbol: 'MSFT', companyName: 'Microsoft Corporation Common Stock' },
    ] } },
  });
  assert.deepEqual(rows, [
    { ticker: 'AAPL', name: 'Apple Inc. Common Stock' },
    { ticker: 'MSFT', name: 'Microsoft Corporation Common Stock' },
  ]);
});

test('parseSecNportHoldings maps names via title (class A/C) and reports unmapped', () => {
  const xml =
    '<edgarSubmission>' +
    '<invstOrSec><name>Apple Inc.</name><title>Apple Inc.</title>' +
    '<pctVal>8.1</pctVal><assetCat>EC</assetCat></invstOrSec>' +
    '<invstOrSec><name>Alphabet Inc.</name><title>Alphabet Inc., Class A</title>' +
    '<pctVal>3.4</pctVal><assetCat>EC</assetCat></invstOrSec>' +
    '<invstOrSec><name>Alphabet Inc.</name><title>Alphabet Inc., Class C</title>' +
    '<pctVal>3.2</pctVal><assetCat>EC</assetCat></invstOrSec>' +
    '<invstOrSec><name>Cash Collateral</name><title>Cash</title>' +
    '<pctVal>0.4</pctVal><assetCat>STIV</assetCat></invstOrSec>' +
    '<invstOrSec><name>Unknown NewCo</name><title>Unknown NewCo</title>' +
    '<pctVal>0.2</pctVal><assetCat>EC</assetCat></invstOrSec>' +
    '</edgarSubmission>';
  // Pad with enough mapped names so MIN_HOLDINGS is reachable after we test
  // the mapper on a realistic short snippet by stubbing via extra blocks.
  const extras = Array.from({ length: 80 }, (_, i) => (
    `<invstOrSec><name>Company ${i}</name><title>Company ${i}</title>` +
    `<pctVal>1.0</pctVal><assetCat>EC</assetCat></invstOrSec>`
  )).join('');
  const map = buildNameTickerMap(
    [
      { ticker: 'AAPL', name: 'Apple Inc' },
      ...Array.from({ length: 80 }, (_, i) => ({ ticker: 'T' + i, name: 'Company ' + i })),
    ],
    { 'alphabet inc class a': 'GOOGL', 'alphabet inc class c': 'GOOG' }
  );
  const { holdings, unmapped } = parseSecNportHoldings(xml + extras, map);
  assert.equal(holdings.find((h) => h.ticker === 'AAPL').weight, 8.1);
  assert.equal(holdings.find((h) => h.ticker === 'GOOGL').weight, 3.4);
  assert.equal(holdings.find((h) => h.ticker === 'GOOG').weight, 3.2);
  assert.ok(unmapped.some((u) => /Unknown NewCo/.test(u.name)));
  assert.ok(!holdings.some((h) => h.ticker === 'CASH'));
});

test('parseSecNportHoldings throws when too few names map to tickers', () => {
  const xml =
    '<invstOrSec><name>Only One</name><title>Only One</title>' +
    '<pctVal>50</pctVal><assetCat>EC</assetCat></invstOrSec>';
  assert.throws(() => parseSecNportHoldings(xml, new Map()), /mapped only/);
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

test('isFallbackSource flags cached and seed sources but not live ones', () => {
  assert.equal(isFallbackSource('invesco'), false);
  assert.equal(isFallbackSource('fmp'), false);
  assert.equal(isFallbackSource('slickcharts'), false);
  assert.equal(isFallbackSource('sec-nport'), false);
  assert.equal(isFallbackSource('invesco-cached'), true);
  assert.equal(isFallbackSource('slickcharts-cached'), true);
  assert.equal(isFallbackSource('fmp-cached'), true);
  assert.equal(isFallbackSource('sec-nport-cached'), true);
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
