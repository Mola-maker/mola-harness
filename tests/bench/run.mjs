// Benchmark runner: fixed task set, scored runs.
//
// Mock mode (default, no key, no network): a scripted provider emits each
// task's expected tool calls, then answers with the expected string. This
// mode validates the harness mechanics and the scoring pipeline — it is
// NOT a model measurement, and its 100% scores must never be quoted as
// model quality.
//
// Real mode (--real, needs DEEPSEEK_API_KEY or MOLA_API_KEY): the same
// tasks run against DeepSeek, and the scores are genuine measurements of
// tool-calling reliability through this loop.
//
// Usage: node tests/bench/run.mjs [--real] [--out report.json]
// Output: JSON report on stdout, human summary on stderr.

import { mkdtempSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLoop } from '../../src/loop.ts';
import { OpenAICompatibleProvider } from '../../src/providers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const tasks = JSON.parse(readFileSync(path.join(here, 'tasks.json'), 'utf8'));
const args = process.argv.slice(2);
const real = args.includes('--real');
const outIdx = args.indexOf('--out');
const outFile = outIdx !== -1 ? args[outIdx + 1] : null;

const apiKey = process.env.DEEPSEEK_API_KEY ?? process.env.MOLA_API_KEY ?? null;
if (real && !apiKey) {
  process.stderr.write('bench: --real needs DEEPSEEK_API_KEY or MOLA_API_KEY in the environment\n');
  process.exit(2);
}

/** Scripted "perfect model" for mock mode: expected calls, then the answer. */
class ScriptedProvider {
  constructor(task) {
    this.task = task;
  }
  async complete(req) {
    const hasTool = req.messages.some((m) => m.role === 'tool');
    if (hasTool) {
      return { text: `Done: ${this.task.answerContains}`, toolCalls: [] };
    }
    return {
      text: '',
      toolCalls: this.task.expectedTools.map((t, i) => ({ id: `bench-${i}`, name: t.name, args: t.args })),
    };
  }
}

function lcsLen(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

const results = [];
for (const task of tasks) {
  const ws = mkdtempSync(path.join(tmpdir(), 'mola-bench-'));
  cpSync(path.join(here, 'fixture'), ws, { recursive: true });
  const provider = real
    ? new OpenAICompatibleProvider('https://api.deepseek.com/v1', apiKey, { timeoutMs: 120_000, maxRetries: 2 })
    : new ScriptedProvider(task);
  const outcome = await runLoop(task.task, {
    provider,
    model: real ? 'deepseek-chat' : 'mock',
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
  });
  const logText = readFileSync(outcome.sessionPath, 'utf8');
  const executed = [];
  for (const line of logText.split('\n').filter(Boolean)) {
    const ev = JSON.parse(line);
    if (ev.type === 'tool_result') executed.push(ev.name);
  }
  const expectedNames = task.expectedTools.map((t) => t.name);
  const toolAccuracy = lcsLen(expectedNames, executed) / Math.max(expectedNames.length, executed.length, 1);
  const answerOk = outcome.answer.includes(task.answerContains);
  const passed = answerOk && toolAccuracy === 1;
  results.push({
    id: task.id,
    passed,
    answerContains: answerOk,
    toolAccuracy,
    executedTools: executed,
    expectedTools: expectedNames,
    steps: outcome.steps,
  });
  process.stderr.write(`${passed ? 'PASS' : 'FAIL'} ${task.id} (tools ${toolAccuracy}, steps ${outcome.steps})\n`);
}

const passedCount = results.filter((r) => r.passed).length;
const report = {
  mode: real ? 'deepseek-real' : 'mock-pipeline',
  tasks: results,
  summary: {
    total: results.length,
    passed: passedCount,
    passRate: passedCount / results.length,
    meanToolAccuracy: results.reduce((s, r) => s + r.toolAccuracy, 0) / results.length,
    meanSteps: results.reduce((s, r) => s + r.steps, 0) / results.length,
  },
};
if (outFile) writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
if (!real) {
  process.stderr.write('note: mock mode scores the harness pipeline, not model quality — do not quote them as DeepSeek results.\n');
}
