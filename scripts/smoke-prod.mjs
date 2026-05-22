#!/usr/bin/env node
// Production smoke test — curl key URLs and validate holdings quality.
const BASE = process.env.PROD_URL || 'https://qqqq-plum.vercel.app';
const MIN_HOLDINGS = 80;

const checks = [
  { path: '/', expectStatus: 200, expectIncludes: 'QQQQ Component Tracker' },
  { path: '/embed.html', expectStatus: 200, expectIncludes: 'Top 10' },
  { path: '/data/holdings.json', expectStatus: 200, json: true },
  { path: '/api/quotes', expectStatus: [200, 503] },
];

let failed = 0;
for (const c of checks) {
  const url = BASE.replace(/\/$/, '') + c.path;
  try {
    const res = await fetch(url, { redirect: 'follow' });
    const statuses = Array.isArray(c.expectStatus) ? c.expectStatus : [c.expectStatus];
    if (!statuses.includes(res.status)) {
      console.error(`FAIL ${c.path}: HTTP ${res.status}`);
      failed++;
      continue;
    }
    const text = await res.text();
    if (c.expectIncludes && !text.includes(c.expectIncludes)) {
      console.error(`FAIL ${c.path}: missing "${c.expectIncludes}"`);
      failed++;
      continue;
    }
    if (c.json) {
      const doc = JSON.parse(text);
      if (!doc.holdings?.length || doc.holdings.length < MIN_HOLDINGS) {
        console.error(`FAIL ${c.path}: only ${doc.holdings?.length || 0} holdings`);
        failed++;
        continue;
      }
    }
    console.log(`OK   ${c.path} (${res.status})`);
  } catch (err) {
    console.error(`FAIL ${c.path}: ${err.message}`);
    failed++;
  }
}
if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll production smoke checks passed.');
