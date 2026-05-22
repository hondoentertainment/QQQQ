#!/usr/bin/env node
// Accessibility smoke check via axe-core loaded in Playwright (no extra npm deps).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { server } from '../server.js';

const AXE = 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js';

test('dashboard passes axe accessibility rules', async (t) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox'],
  });
  t.after(() => browser.close());

  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}`);
  await page.waitForSelector('table tbody tr', { timeout: 15000 });
  await page.addScriptTag({ url: AXE });
  const results = await page.evaluate(async () => {
    return axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } });
  });
  const serious = results.violations.filter((v) =>
    (v.impact === 'serious' || v.impact === 'critical') && v.id !== 'color-contrast'
  );
  if (serious.length) {
    console.error(serious.map((v) => `${v.id}: ${v.help} (${v.nodes.length} nodes)`).join('\n'));
  }
  assert.equal(serious.length, 0, `axe found ${serious.length} serious/critical violations`);
});
