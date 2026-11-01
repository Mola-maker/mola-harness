// Bench smoke test: the bench runner must complete in mock mode with a
// well-formed report (pipeline self-test, not a model measurement).

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(here, 'bench', 'run.mjs');

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

const r = spawnSync(process.execPath, [runner], { encoding: 'utf8' });
check('bench runner exits 0', r.status === 0, r.stderr.slice(0, 300));
let report = null;
try {
  report = JSON.parse(r.stdout);
} catch {
  // Not JSON.
}
check('bench report parses', report !== null);
if (report) {
  check('bench mode is mock-pipeline', report.mode === 'mock-pipeline', report.mode);
  check('bench covers 5 tasks', report.tasks.length === 5, String(report.tasks?.length));
  check('bench mock pass rate is 1', report.summary.passRate === 1, String(report.summary.passRate));
  check('bench mean tool accuracy is 1', report.summary.meanToolAccuracy === 1, String(report.summary.meanToolAccuracy));
  check('every task passed', report.tasks.every((t) => t.passed));
}

// --real without a key must fail fast, never touch a real provider.
const env = { ...process.env };
delete env.DEEPSEEK_API_KEY;
delete env.MOLA_API_KEY;
const r2 = spawnSync(process.execPath, [runner, '--real'], { encoding: 'utf8', env });
check('--real without key exits 2 with a clear error', r2.status === 2 && r2.stderr.includes('needs DEEPSEEK_API_KEY'), r2.stderr.slice(0, 200));

if (failures > 0) {
  console.log(`BENCH FAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log('BENCH OK');
