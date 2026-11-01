// Config tests: two-level precedence, validation errors, secret rejection.
// Runs with an isolated HOME/XDG so the real user config is never read.

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';

const base = mkdtempSync(path.join(tmpdir(), 'mola-config-'));
process.env.HOME = base;
process.env.XDG_CONFIG_HOME = path.join(base, 'xdg');
delete process.env.MOLA_PROVIDER;
delete process.env.MOLA_MODEL;
delete process.env.MOLA_MAX_STEPS;
delete process.env.MOLA_API_KEY;
delete process.env.DEEPSEEK_API_KEY;

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}
function throws(name, fn, needle) {
  let msg = '';
  try {
    fn();
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  check(name, msg.includes(needle), msg.slice(0, 200));
}

const ws = path.join(base, 'ws');
mkdirSync(path.join(ws, '.mola'), { recursive: true });
mkdirSync(path.join(base, 'xdg', 'mola'), { recursive: true });

// User config: provider mock, maxSteps 3, a permission rule.
writeFileSync(
  path.join(base, 'xdg', 'mola', 'mola.json'),
  JSON.stringify({ provider: 'mock', maxSteps: 3, permissions: { write: 'deny' } }),
  'utf8',
);
// Project config overrides maxSteps and adds a hook; user permission survives (merge).
writeFileSync(
  path.join(ws, '.mola', 'mola.json'),
  JSON.stringify({ maxSteps: 7, hooks: { 'session:start': 'echo hi' } }),
  'utf8',
);

let cfg = loadConfig({ workspace: ws });
check('project overrides user maxSteps', cfg.maxSteps === 7, String(cfg.maxSteps));
check('user permission survives merge', cfg.permissions.write === 'deny');
check('project hook present', cfg.hooks['session:start'] === 'echo hi');
check('provider from user config', cfg.provider === 'mock');

// Env overrides file.
process.env.MOLA_MAX_STEPS = '11';
cfg = loadConfig({ workspace: ws });
check('env overrides file maxSteps', cfg.maxSteps === 11, String(cfg.maxSteps));
delete process.env.MOLA_MAX_STEPS;

// CLI overrides env.
process.env.MOLA_MAX_STEPS = '11';
cfg = loadConfig({ workspace: ws, maxSteps: 5 });
check('CLI overrides env maxSteps', cfg.maxSteps === 5, String(cfg.maxSteps));
delete process.env.MOLA_MAX_STEPS;

// Unknown key.
writeFileSync(path.join(ws, '.mola', 'mola.json'), JSON.stringify({ bogusKey: 1 }), 'utf8');
throws('unknown key errors clearly', () => loadConfig({ workspace: ws }), 'unknown key "bogusKey"');

// Secret-like key.
writeFileSync(path.join(ws, '.mola', 'mola.json'), JSON.stringify({ apiKey: 'dummy-not-a-real-key' }), 'utf8');
throws('secret in config rejected', () => loadConfig({ workspace: ws }), 'must never contain secrets');

// Invalid JSON.
writeFileSync(path.join(ws, '.mola', 'mola.json'), '{not json', 'utf8');
throws('invalid JSON errors with file path', () => loadConfig({ workspace: ws }), 'not valid JSON');

// Wrong type.
writeFileSync(path.join(ws, '.mola', 'mola.json'), JSON.stringify({ maxSteps: 'many' }), 'utf8');
throws('wrong type errors with key', () => loadConfig({ workspace: ws }), '"maxSteps" must be a positive integer');

// Bad permission value.
writeFileSync(path.join(ws, '.mola', 'mola.json'), JSON.stringify({ permissions: { read: 'maybe' } }), 'utf8');
throws('bad permission value errors', () => loadConfig({ workspace: ws }), 'permissions["read"]');

// Bad MCP server entry.
writeFileSync(path.join(ws, '.mola', 'mola.json'), JSON.stringify({ mcpServers: { s: { args: [] } } }), 'utf8');
throws('MCP server without command errors', () => loadConfig({ workspace: ws }), 'mcpServers["s"].command');

// Bad provider name (CLI).
writeFileSync(path.join(ws, '.mola', 'mola.json'), JSON.stringify({}), 'utf8');
throws('unknown provider errors', () => loadConfig({ workspace: ws, provider: 'nope' }), 'unknown provider');

// Real provider without key errors (not silent mock fallback).
throws('deepseek without key errors', () => loadConfig({ workspace: ws, provider: 'deepseek' }), 'needs an API key');

if (failures > 0) {
  console.log(`CONFIG FAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log('CONFIG OK');
