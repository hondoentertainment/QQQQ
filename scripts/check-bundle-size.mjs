#!/usr/bin/env node
// Fail CI when the static dashboard bundle exceeds the performance budget.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUDGET_BYTES = 180 * 1024;

const FILES = ['index.html', 'embed.html', 'app.js', 'lib/analytics.js', 'styles.css', 'manifest.json', 'sw.js', 'icon.svg'];

let total = 0;
for (const file of FILES) {
  const filePath = path.join(ROOT, file);
  const { size } = await stat(filePath);
  total += size;
  console.log(`${file}: ${(size / 1024).toFixed(1)} KiB`);
}

console.log(`Total static bundle: ${(total / 1024).toFixed(1)} KiB (budget ${(BUDGET_BYTES / 1024).toFixed(0)} KiB)`);

if (total > BUDGET_BYTES) {
  console.error(`Bundle exceeds budget by ${((total - BUDGET_BYTES) / 1024).toFixed(1)} KiB`);
  process.exit(1);
}
