// Hook tests: commands run with event env, failures never throw,
// timeouts are reported, output is captured.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runHook } from '../src/hooks.ts';

const ws = mkdtempSync(path.join(tmpdir(), 'mola-hooks-'));
let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

let r = await runHook('echo hook-$MOLA_HOOK_EVENT-$MOLA_HOOK_TOOL', { event: 'before-tool', tool: 'read' }, ws);
check('hook runs with event env', r.ok && r.stdout.includes('hook-before-tool-read'), r.stdout);
r = await runHook('exit 3', { event: 'session:end' }, ws);
check('failing hook reports ok=false, no throw', !r.ok && r.code === 3, String(r.code));
r = await runHook('sleep 30', { event: 'session:start' }, ws);
check('slow hook times out', !r.ok && r.timedOut, `timedOut=${r.timedOut}`);
r = await runHook('echo secret-$MOLA_API_KEY', { event: 'session:start' }, ws);
check('hook env is scrubbed (no API key leaked)', !r.stdout.includes('sk-') && r.stdout.trim() === 'secret-', r.stdout);

if (failures > 0) {
  console.log(`HOOKS FAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log('HOOKS OK');
