// SIGINT test: spawn the hanging loop, SIGINT it, verify the session
// log carries a session_end marker with reason "interrupted" and the
// process exits promptly (not hanging on the provider).

import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ws = mkdtempSync(path.join(tmpdir(), 'mola-sigint-'));

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

const child = spawn(process.execPath, [path.join(here, 'helpers', 'slow-run.mjs'), ws], { stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '';
child.stdout.on('data', (d) => {
  stdout += d;
});
await new Promise((r) => setTimeout(r, 800));
check('helper still running before SIGINT', child.exitCode === null);
child.kill('SIGINT');
const exit = await new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
check('process exits after SIGINT', exit.code !== null, JSON.stringify(exit));
const files = readdirSync(path.join(ws, '.mola', 'sessions'));
check('session log written', files.length === 1, files.join(','));
const logText = readFileSync(path.join(ws, '.mola', 'sessions', files[0]), 'utf8');
check('session_end reason is interrupted', logText.includes('"session_end"') && logText.includes('"interrupted"'), logText.slice(-300));
check('helper reported interrupted outcome', stdout.includes('interrupted=true'), stdout);

if (failures > 0) {
  console.log(`SIGINT FAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log('SIGINT OK');
process.exit(0);
