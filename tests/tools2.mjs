// Extended tool tests: write, glob, grep, bash allowlist extension,
// and scrubbed subprocess env.

import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runTool, scrubbedEnv } from '../src/tools.ts';

const ws = mkdtempSync(path.join(tmpdir(), 'mola-tools2-'));
writeFileSync(path.join(ws, 'a.txt'), 'hello bench-marker\nsecond line\n', 'utf8');
mkdirSync(path.join(ws, 'sub'), { recursive: true });
writeFileSync(path.join(ws, 'sub', 'b.md'), '# notes\nbench-marker again\n', 'utf8');
writeFileSync(path.join(ws, 'sub', 'c.txt'), 'nothing here\n', 'utf8');

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}
const ctx = { workspace: ws };

// write
let r = await runTool('write', { path: 'out/new.txt', content: 'fresh content' }, ctx);
check('write creates parent dirs + file', r.ok && readFileSync(path.join(ws, 'out', 'new.txt'), 'utf8') === 'fresh content', r.content);
r = await runTool('write', { path: '../escape.txt', content: 'x' }, ctx);
check('write refuses escape', !r.ok);
r = await runTool('write', { path: '.mola/sessions/x.jsonl', content: 'x' }, ctx);
check('write refuses .mola paths', !r.ok);
r = await runTool('write', { path: 'x.txt', content: 42 }, ctx);
check('write refuses non-string content', !r.ok);

// glob
r = await runTool('glob', { pattern: '**/*.txt' }, ctx);
check('glob ** matches nested', r.ok && r.content.includes('a.txt') && r.content.includes('sub/c.txt') && r.content.includes('out/new.txt'), r.content);
r = await runTool('glob', { pattern: 'sub/*.md' }, ctx);
check('glob segment * works', r.ok && r.content.trim() === 'sub/b.md', r.content);
r = await runTool('glob', { pattern: '*.nomatch' }, ctx);
check('glob no matches reported', r.ok && r.content.includes('(no matches)'));
r = await runTool('glob', { pattern: '' }, ctx);
check('glob empty pattern errors', !r.ok);

// grep
r = await runTool('grep', { pattern: 'bench-marker' }, ctx);
check('grep finds matches with file:line', r.ok && r.content.includes('a.txt:1:') && r.content.includes('sub/b.md:2:'), r.content);
r = await runTool('grep', { pattern: 'bench-marker', path: 'sub' }, ctx);
check('grep scoped to dir', r.ok && !r.content.includes('a.txt'), r.content);
r = await runTool('grep', { pattern: '[' }, ctx);
check('grep invalid regex errors', !r.ok);
r = await runTool('grep', { pattern: 'nothing here', path: 'sub/c.txt' }, ctx);
check('grep single file works', r.ok && r.content.includes('sub/c.txt:1:'), r.content);
r = await runTool('grep', { pattern: 'x', path: '../escape' }, ctx);
check('grep refuses escape scope', !r.ok);

// bash allowlist extension + env scrub
r = await runTool('bash', { command: 'printenv HOME' }, { workspace: ws, bashAllowlistExtra: ['printenv'] });
check('bash allowlist extendable via config', r.content.includes('stdout:'), r.content.slice(0, 100));
check('bash env is scrubbed (HOME absent: printenv exits 1, empty stdout)', r.content.includes('exit: 1') && r.content.includes('stdout:\n\n'), JSON.stringify(r.content.slice(0, 100)));
r = await runTool('bash', { command: 'printenv PATH' }, { workspace: ws, bashAllowlistExtra: ['printenv'] });
check('bash scrubbed env keeps PATH', r.ok && r.content.includes('/usr/bin'), r.content.slice(0, 150));
r = await runTool('bash', { command: 'printenv HOME' }, ctx);
check('bash without extension still refuses', !r.ok);
r = await runTool('bash', { command: 'echo $HOME' }, ctx);
check('bash still refuses $ substitution', !r.ok);

// scrubbedEnv helper
const env = scrubbedEnv();
check('scrubbed env keeps PATH only from allowlist', !('HOME' in env) && !('MOLA_API_KEY' in env) && 'PATH' in env);

// .mola and node_modules are invisible to glob/grep
mkdirSync(path.join(ws, '.mola', 'sessions'), { recursive: true });
writeFileSync(path.join(ws, '.mola', 'sessions', 's.jsonl'), 'bench-marker\n', 'utf8');
r = await runTool('grep', { pattern: 'bench-marker' }, ctx);
check('grep skips .mola', r.ok && !r.content.includes('.mola'), r.content);

if (failures > 0) {
  console.log(`TOOLS2 FAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log('TOOLS2 OK');
