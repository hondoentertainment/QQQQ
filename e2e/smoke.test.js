// End-to-end smoke test: starts the static server and drives the dashboard
// in a headless browser to confirm it renders and is interactive.
// Run with: npm run test:e2e
//
// Needs a Chromium browser. CI installs one with `npx playwright install`;
// set CHROMIUM_PATH to point at a pre-provisioned browser in environments
// where Playwright's managed download is unavailable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { server } from '../server.js';

const SEARCH = 'input[type="search"], input[type="text"]';

/** Poll until the holdings table has exactly `expected` rows. */
async function waitForRowCount(page, expected) {
  for (let i = 0; i < 30; i++) {
    if ((await page.locator('table tbody tr').count()) === expected) return;
    await page.waitForTimeout(100);
  }
  assert.fail(`holdings table never settled at ${expected} rows`);
}

test('dashboard renders and is interactive', async (t) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox'],
  });
  t.after(() => browser.close());

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}`);
  await page.waitForSelector('table tbody tr', { timeout: 15000 });

  await t.test('shows the header and the full holdings table', async () => {
    assert.equal(await page.title(), 'QQQQ Component Tracker');
    assert.equal((await page.locator('h1').textContent())?.trim(), 'QQQQ Component Tracker');
    const rows = await page.locator('table tbody tr').count();
    assert.ok(rows > 50, `expected the full holdings table, got ${rows} rows`);
  });

  await t.test('filters the holdings table by ticker', async () => {
    await page.locator(SEARCH).first().fill('AAPL');
    await waitForRowCount(page, 1);
    await page.locator(SEARCH).first().fill('');
    await page.waitForSelector('table tbody tr:nth-child(2)', { timeout: 5000 });
  });

  await t.test('sorts the holdings table by ticker', async () => {
    await page.locator('th[data-sort="ticker"]').click();
    const tickers = (await page.locator('table tbody tr.row .tk').allTextContents())
      .map((t) => t.replace(/▸/g, '').trim());
    const sorted = [...tickers].sort();
    assert.deepEqual(tickers, sorted);
  });

  await t.test('filters the holdings table by sector', async () => {
    const options = await page.locator('#sectorFilter option').allTextContents();
    const sector = options.find((o) => o && o !== 'All sectors');
    assert.ok(sector, 'expected at least one sector option');
    await page.locator('#sectorFilter').selectOption({ label: sector });
    const count = await page.locator('table tbody tr.row').count();
    assert.ok(count > 0 && count < 50, `expected a narrowed sector view, got ${count} rows`);
    await page.locator('#sectorFilter').selectOption({ label: 'All sectors' });
  });

  await t.test('expands a holding row on click', async () => {
    await page.locator('table tbody tr.row').first().click();
    await page.waitForSelector('[aria-expanded="true"]', { timeout: 5000 });
  });

  await t.test('exports the current view as CSV', async () => {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#exportBtn').click(),
    ]);
    assert.match(download.suggestedFilename(), /^qqqq-holdings-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  await t.test('adds a holding to the comparison chart', async () => {
    await page.locator('#compareAdd').selectOption({ index: 1 });
    await page.waitForSelector('.cmp-chip', { timeout: 5000 });
    assert.equal(await page.locator('.cmp-chip').count(), 1);
    assert.equal(await page.locator('#compareChart svg').count(), 1);
  });

  await t.test('renders weight history and sector trend panels', async () => {
    await page.waitForSelector('#weightHistoryChart svg', { timeout: 5000 });
    await page.waitForSelector('#sectorTrendChart svg', { timeout: 5000 });
  });

  await t.test('chart points expose hover titles', async () => {
    const titles = await page.locator('#weightHistoryChart circle title').count();
    assert.ok(titles > 0, 'expected weight history chart hover titles');
    const sectorTitles = await page.locator('#sectorTrendChart circle title').count();
    assert.ok(sectorTitles > 0, 'expected sector trend chart hover titles');
  });

  await t.test('dashboard screenshot stays within visual bounds', async () => {
    await page.waitForSelector('.cards .card', { timeout: 5000 });
    const cards = await page.locator('.cards .card').count();
    assert.ok(cards >= 4, 'expected summary cards');
    const shot = await page.screenshot({ type: 'png' });
    assert.ok(shot.length > 40000, 'screenshot unexpectedly small');
    assert.ok(shot.length < 350000, 'screenshot unexpectedly large');
  });
});
