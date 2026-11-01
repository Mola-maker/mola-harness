// Compaction tests: pure transcript trimming + loop integration
// (log keeps full history while the live transcript shrinks).

import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compactTranscript, transcriptChars } from '../src/compaction.ts';
import { runLoop } from '../src/loop.ts';

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

const msgs = [{ role: 'system', content: 'sys' }];
for (let i = 0; i < 10; i++) {
  msgs.push({ role: 'user', content: `turn ${i} ` + 'x'.repeat(500) });
  msgs.push({ role: 'assistant', content: `answer ${i} ` + 'y'.repeat(500) });
}
const cfg = { maxChars: 2000, keepMessages: 4 };
const before = transcriptChars(msgs);
const r = compactTranscript(msgs, cfg);
check('compaction triggers over budget', r.compacted && r.removedMessages > 0, `removed=${r.removedMessages}`);
check('system prompt kept', r.messages[0].role === 'system' && r.messages[0].content === 'sys');
check('summary message inserted', r.messages[1].role === 'system' && r.messages[1].content.includes('compacted'));
check('recent messages kept', r.messages.length === 2 + cfg.keepMessages, String(r.messages.length));
check('summary is deterministic', compactTranscript(msgs, cfg).summary === r.summary);
check('under budget is a no-op', !compactTranscript([{ role: 'system', content: 'a' }], cfg).compacted);

// Loop integration: tiny budget forces compaction; session log stays full.
const ws = mkdtempSync(path.join(tmpdir(), 'mola-compact-'));
writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'compact-marker' }), 'utf8');
class LongProvider {
  constructor() {
    this.calls = 0;
  }
  async complete(req) {
    this.calls++;
    const hasTool = req.messages.some((m) => m.role === 'tool');
    if (hasTool) return { text: 'final answer here', toolCalls: [] };
    return {
      text: 'x'.repeat(3000),
      toolCalls: [{ id: 'c1', name: 'read', args: { path: 'package.json' } }],
    };
  }
}
const provider = new LongProvider();
const out = await runLoop('read package.json', {
  provider,
  model: 'mock',
  workspace: ws,
  maxSteps: 5,
  dryRun: false,
  yes: true,
  sandbox: false,
  permissions: {},
  hooks: {},
  skillsDir: path.join(ws, 'skills'),
  mcpServers: {},
  bashAllowlistExtra: [],
  compaction: { maxChars: 1000, keepMessages: 4 },
  subagent: { maxDepth: 1, maxSteps: 5 },
  asker: null,
});
check('loop completes despite tiny budget', out.answer === 'final answer here', out.answer);
const logText = readFileSync(path.join(ws, '.mola', 'sessions', readdirSync(path.join(ws, '.mola', 'sessions'))[0]), 'utf8');
check('session log records compaction event', logText.includes('"compaction"'));
check('session log keeps full history (long assistant text)', logText.includes('x'.repeat(100)));

if (failures > 0) {
  console.log(`COMPACTION FAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log('COMPACTION OK');
