// Smoke test (mock provider only — no network, no keys).
// 1. Runs the CLI on a temp workspace: mock reads package.json, answers.
// 2. Checks the JSONL session log records the read call + result.
// 3. Checks the safety gates directly: bash denylist, metacharacters,
//    workspace escape refusal, and the allowlist happy path.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTool } from '../src/tools.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const cli = path.join(repo, 'src', 'cli.ts');

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

// --- 1. mock loop via CLI ---
const ws = mkdtempSync(path.join(tmpdir(), 'mola-smoke-'));
writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'mola-smoke-marker', version: '0.0.0' }), 'utf8');
const run = spawnSync(process.execPath, [cli, 'run', 'read package.json and tell me its name', '--provider', 'mock', '--workspace', ws], { encoding: 'utf8' });
check('cli exits 0', run.status === 0, run.stderr.trim().slice(0, 200));
check('answer contains the marker name', (run.stdout ?? '').includes('mola-smoke-marker'));
const sessionDir = path.join(ws, '.mola', 'sessions');
let sessionText = '';
try {
  const files = readdirSync(sessionDir);
  check('session log written', files.length === 1);
  sessionText = readFileSync(path.join(sessionDir, files[0]), 'utf8');
} catch {
  check('session log written', false);
}
check('session log records the read call', sessionText.includes('"read"'));
check('session log records the file content', sessionText.includes('mola-smoke-marker'));

// --- 2. safety gates ---
const ctx = { workspace: ws };
const denyRm = await runTool('bash', { command: 'rm -rf /' }, ctx);
check('bash refuses non-allowlisted command', !denyRm.ok);
const denyPipe = await runTool('bash', { command: 'ls | cat' }, ctx);
check('bash refuses pipes', !denyPipe.ok);
const denyEscape = await runTool('read', { path: '../escape.txt' }, ctx);
check('read refuses workspace escape', !denyEscape.ok);
const okEcho = await runTool('bash', { command: 'echo hello' }, ctx);
check('bash allowlist happy path', okEcho.ok && okEcho.content.includes('hello'));
const okRead = await runTool('read', { path: 'package.json' }, ctx);
check('read happy path', okRead.ok && okRead.content.includes('mola-smoke-marker'));

if (failures > 0) {
  console.log(`SMOKE FAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log('SMOKE OK');
