// Resume/fork/sessions tests at the CLI level (isolated HOME/XDG).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const cli = path.join(repo, 'src', 'cli.ts');
const base = mkdtempSync(path.join(tmpdir(), 'mola-resume-'));
const ws = path.join(base, 'ws');
import { mkdirSync } from 'node:fs';
mkdirSync(ws, { recursive: true });
writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'resume-marker' }), 'utf8');
const env = {
  ...process.env,
  HOME: base,
  XDG_CONFIG_HOME: path.join(base, 'xdg'),
  MOLA_PROVIDER: undefined,
};
delete env.MOLA_PROVIDER;

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}
function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env });
}

// 1. Run with max-steps 1 -> stopped, no answer.
let r = runCli(['run', 'read package.json and tell me its name', '--provider', 'mock', '--workspace', ws, '--max-steps', '1']);
check('max-steps run stops without answer', r.status === 0 && r.stdout.includes('stopped at max steps'), r.stdout.slice(0, 150));
const sessionId = r.stdout.match(/\[session: .*\/([^/]+)\.jsonl\]/)?.[1];
check('session id captured', !!sessionId, r.stdout);

// 2. sessions lists it.
r = runCli(['sessions', '--workspace', ws]);
check('sessions lists the run', r.stdout.includes(sessionId), r.stdout.slice(0, 200));

// 3. Resume completes it.
r = runCli(['resume', sessionId, '--provider', 'mock', '--workspace', ws, '--max-steps', '10']);
check('resume completes with marker', r.status === 0 && r.stdout.includes('resume-marker'), r.stdout.slice(0, 200));

// 4. Resume of an answered session without follow-up refuses cleanly.
const answeredId = r.stdout.match(/\[session: .*\/([^/]+)\.jsonl\]/)?.[1];
r = runCli(['resume', answeredId, '--provider', 'mock', '--workspace', ws]);
check('resume of answered session needs follow-up', r.status === 0 && r.stdout.includes('already ended'), r.stdout.slice(0, 200));

// 5. Resume with follow-up continues.
r = runCli(['resume', answeredId, 'and confirm again', '--provider', 'mock', '--workspace', ws]);
check('resume with follow-up works', r.status === 0 && r.stdout.includes('resume-marker'), r.stdout.slice(0, 200));

// 6. Fork opens a new branch.
r = runCli(['fork', sessionId, '--provider', 'mock', '--workspace', ws, '--max-steps', '10']);
check('fork completes with marker', r.status === 0 && r.stdout.includes('resume-marker'), r.stdout.slice(0, 200));
check('fork creates a different session', !r.stdout.includes(sessionId), r.stdout.slice(0, 200));

// 7. Unknown session id errors.
r = runCli(['resume', 'no-such-session', '--provider', 'mock', '--workspace', ws]);
check('unknown session errors', r.status !== 0 && r.stderr.includes('no session found'), r.stderr.slice(0, 200));

// 8. Prefix match works (unique prefix: full id minus its last 2 chars).
r = runCli(['sessions', '--workspace', ws]);
const prefix = sessionId.slice(0, -2);
r = runCli(['resume', prefix, 'follow-up via prefix', '--provider', 'mock', '--workspace', ws]);
check('prefix session id resolves', r.status === 0 && r.stdout.includes('resume-marker'), r.stdout.slice(0, 200));

if (failures > 0) {
  console.log(`RESUME FAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log('RESUME OK');
