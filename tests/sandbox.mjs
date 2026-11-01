// Sandbox flag test: without bwrap on this machine, --sandbox must warn
// clearly and fall back to process-level isolation (never silently
// claim a sandbox). If bwrap IS present, the sandboxed run must work.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runTool } from '../src/tools.ts';
import { bwrapAvailable } from '../src/sandbox.ts';

const ws = mkdtempSync(path.join(tmpdir(), 'mola-sandbox-'));
writeFileSync(path.join(ws, 'x.txt'), 'hi\n', 'utf8');

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

let fallbackCalls = 0;
const r = await runTool('bash', { command: 'echo sandboxed' }, {
  workspace: ws,
  sandbox: true,
  onSandboxFallback: () => {
    fallbackCalls++;
  },
});
if (bwrapAvailable()) {
  check('bwrap present: sandboxed echo works', r.ok && r.content.includes('sandboxed'), r.content.slice(0, 200));
  check('bwrap present: no fallback warning', fallbackCalls === 0);
} else {
  check('bwrap absent: fallback warning fired once', fallbackCalls === 1, String(fallbackCalls));
  check('bwrap absent: command still runs (process-level)', r.ok && r.content.includes('sandboxed'), r.content.slice(0, 200));
}
check('bwrapAvailable() is a boolean', typeof bwrapAvailable() === 'boolean');

if (failures > 0) {
  console.log(`SANDBOX FAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log('SANDBOX OK');
