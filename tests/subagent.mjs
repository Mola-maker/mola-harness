// Subagent tests: a scripted parent provider calls the subagent tool;
// the child runs with isolated history, a step cap, and a depth cap,
// and only its summary reaches the parent.

import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runLoop } from '../src/loop.ts';
import { MockProvider } from '../src/providers.ts';

const ws = mkdtempSync(path.join(tmpdir(), 'mola-sub-'));
writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'sub-marker' }), 'utf8');

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

const baseOpts = {
  provider: new MockProvider(),
  model: 'mock',
  workspace: ws,
  maxSteps: 10,
  dryRun: false,
  yes: true,
  sandbox: false,
  permissions: {},
  hooks: {},
  skillsDir: path.join(ws, 'skills'),
  mcpServers: {},
  bashAllowlistExtra: [],
  compaction: { maxChars: 24_000, keepMessages: 8 },
  subagent: { maxDepth: 1, maxSteps: 5 },
  asker: null,
};

// Scripted provider: first call -> subagent tool; after the subagent
// result arrives -> final answer quoting the summary. For any other
// task (e.g. inside the child loop) it behaves like the mock provider.
class ParentProvider {
  async complete(req) {
    const userTask = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const isDelegation = userTask.includes('delegate');
    if (isDelegation) {
      const hasSub = req.messages.some((m) => m.role === 'tool' && m.name === 'subagent');
      if (hasSub) {
        const sub = req.messages.find((m) => m.role === 'tool' && m.name === 'subagent');
        return { text: `parent final: ${sub.content.slice(0, 200)}`, toolCalls: [] };
      }
      return {
        text: '',
        toolCalls: [{ id: 'p1', name: 'subagent', args: { task: 'read package.json and tell me its name' } }],
      };
    }
    const done = req.messages.some((m) => m.role === 'tool');
    if (done) {
      const tool = req.messages.find((m) => m.role === 'tool');
      return { text: `Done. It contains: ${tool.content.replace(/\s+/g, ' ').slice(0, 200)}`, toolCalls: [] };
    }
    const m = userTask.match(/[A-Za-z0-9_./-]+\.(json|md|txt|ts|js|mjs)/);
    return {
      text: '',
      toolCalls: [{ id: 'mock-call-1', name: 'read', args: { path: m ? m[0] : 'package.json' } }],
    };
  }
}

const out = await runLoop('delegate the package.json question', { ...baseOpts, provider: new ParentProvider() });
check('parent answer contains child summary', out.answer.includes('subagent summary') && out.answer.includes('sub-marker'), out.answer.slice(0, 200));

// The child wrote its own session log, separate from the parent's.
const sessions = readdirSync(path.join(ws, '.mola', 'sessions'));
check('parent + child session logs exist', sessions.length === 2, sessions.join(','));
const childText = sessions
  .map((f) => readFileSync(path.join(ws, '.mola', 'sessions', f), 'utf8'))
  .find((t) => t.includes('parentSessionId'));
check('child log references parent session', childText !== undefined);
check('child log has its own task event', childText?.includes('"type":"task","task":"read package.json') === true);
const parentText = sessions
  .map((f) => readFileSync(path.join(ws, '.mola', 'sessions', f), 'utf8'))
  .find((t) => !t.includes('parentSessionId'));
check('parent log has subagent tool result', parentText?.includes('"type":"tool_result","name":"subagent"') === true);
check('parent log has no child task event (isolated history)', parentText?.includes('"type":"task","task":"read package.json') === false);

// Depth cap: with maxDepth 0 the subagent tool is not offered at all.
class DepthProbeProvider {
  constructor() {
    this.seenTools = [];
  }
  async complete(req) {
    this.seenTools = req.tools.map((t) => t.name);
    return { text: 'no tools needed', toolCalls: [] };
  }
}
const probe = new DepthProbeProvider();
await runLoop('probe', { ...baseOpts, provider: probe, subagent: { maxDepth: 0, maxSteps: 5 } });
check('maxDepth 0 hides subagent tool', !probe.seenTools.includes('subagent'), probe.seenTools.join(','));
const probe2 = new DepthProbeProvider();
await runLoop('probe', { ...baseOpts, provider: probe2, subagent: { maxDepth: 1, maxSteps: 5 } });
check('maxDepth 1 offers subagent tool', probe2.seenTools.includes('subagent'), probe2.seenTools.join(','));

if (failures > 0) {
  console.log(`SUBAGENT FAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log('SUBAGENT OK');
