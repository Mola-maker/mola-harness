// Test runner: runs every tests/*.mjs except this file, sequentially,
// in a fresh process each (so HOME/XDG isolation per file works).
// Usage: npm test  (or: node tests/run.mjs)

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((f) => f.endsWith('.mjs') && f !== 'run.mjs')
  .sort();

let failed = [];
for (const f of files) {
  console.log(`\n=== ${f} ===`);
  const r = spawnSync(process.execPath, [path.join(here, f)], { stdio: 'inherit' });
  if (r.status !== 0) failed.push(f);
}

if (failed.length > 0) {
  console.log(`\nTESTS FAILED: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`\nALL TESTS OK (${files.length} files)`);
