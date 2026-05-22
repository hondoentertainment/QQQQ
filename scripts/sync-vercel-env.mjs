#!/usr/bin/env node
// Sync FMP_API_KEY from the environment (or .env via npm scripts) to Vercel.
// Usage: FMP_API_KEY=yourkey node scripts/sync-vercel-env.mjs
import { spawnSync } from 'node:child_process';

const key = process.env.FMP_API_KEY;
if (!key) {
  console.error('FMP_API_KEY is not set. Add it to .env or export it first.');
  process.exit(1);
}

for (const target of ['production', 'preview', 'development']) {
  const res = spawnSync(
    'npx',
    ['vercel', 'env', 'add', 'FMP_API_KEY', target, '--force'],
    { input: key, stdio: ['pipe', 'inherit', 'inherit'], shell: true }
  );
  if (res.status !== 0) {
    console.error(`Failed to set FMP_API_KEY for ${target}`);
    process.exit(res.status || 1);
  }
  console.log(`Set FMP_API_KEY for ${target}`);
}
