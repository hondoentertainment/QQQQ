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

  await t.test('expands a holding row on click', async () => {
    await page.locator('table tbody tr').first().click();
    await page.waitForSelector('[aria-expanded="true"]', { timeout: 5000 });
  });

  await t.test('adds a holding to the comparison chart', async () => {
    await page.locator('#compareAdd').selectOption({ index: 1 });
    await page.waitForSelector('.cmp-chip', { timeout: 5000 });
    assert.equal(await page.locator('.cmp-chip').count(), 1);
    assert.equal(await page.locator('#compareChart svg').count(), 1);
  });
});
