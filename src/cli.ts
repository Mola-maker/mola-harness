#!/usr/bin/env node
// mola CLI (v0.1): `node src/cli.ts run "task" [--provider mock|deepseek|custom]
// [--model X] [--workspace DIR] [--max-steps N] [--dry-run]`
// No install step: zero dependencies, run with Node >= 22 (type-stripping).

import path from 'node:path';
import { loadConfig } from './config.ts';
import { MockProvider, OpenAICompatibleProvider } from './providers.ts';
import type { Provider } from './providers.ts';
import { runLoop } from './loop.ts';

const HELP = `mola-harness v0.1 — a minimal agent harness for individual developers

Usage:
  node src/cli.ts run "task" [options]

Options:
  --provider mock|deepseek|custom   (default: mock, or MOLA_PROVIDER)
  --model MODEL                     (default: deepseek-chat for deepseek, mock for mock)
  --workspace DIR                   (default: current directory, or MOLA_WORKSPACE)
  --max-steps N                     (default: 10, or MOLA_MAX_STEPS)
  --dry-run                         print planned tool calls without executing them
  --help                            show this help

Real providers need a key in the environment, never on the command line:
  MOLA_API_KEY (or DEEPSEEK_API_KEY for the deepseek preset)
  MOLA_BASE_URL (required for the custom preset)

Examples:
  node src/cli.ts run "read package.json and tell me its name" --provider mock
  DEEPSEEK_API_KEY=... node src/cli.ts run "summarize README.md" --provider deepseek
`;

function parseArgs(argv: string[]): { command: string; task: string; overrides: Record<string, string | number | boolean> } {
  const args = [...argv];
  if (args[0] === '--help' || args[0] === '-h' || args.length === 0) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (args[0] !== 'run') {
    throw new Error(`unknown command: ${args[0]} (expected "run"; see --help)`);
  }
  args.shift();
  const taskParts: string[] = [];
  const overrides: Record<string, string | number | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--provider' || a === '--model' || a === '--workspace' || a === '--max-steps') {
      const v = args[++i];
      if (v === undefined) throw new Error(`flag ${a} needs a value`);
      overrides[a.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] =
        a === '--max-steps' ? Number(v) : v;
    } else if (a === '--dry-run') {
      overrides.dryRun = true;
    } else if (a.startsWith('--')) {
      throw new Error(`unknown flag: ${a} (see --help)`);
    } else {
      taskParts.push(a);
    }
  }
  const task = taskParts.join(' ').trim();
  if (!task) throw new Error('run needs a task string');
  return { command: 'run', task, overrides };
}

async function main(): Promise<void> {
  const { task, overrides } = parseArgs(process.argv.slice(2));
  const config = loadConfig({
    provider: overrides.provider as string | undefined,
    model: overrides.model as string | undefined,
    workspace: overrides.workspace as string | undefined,
    maxSteps: overrides.maxSteps as number | undefined,
    dryRun: overrides.dryRun as boolean | undefined,
  });
  const workspace = path.resolve(config.workspace);
  let provider: Provider;
  if (config.provider === 'mock') {
    provider = new MockProvider();
  } else {
    provider = new OpenAICompatibleProvider(config.baseUrl as string, config.apiKey as string);
  }
  const outcome = await runLoop(task, {
    provider,
    model: config.model,
    workspace,
    maxSteps: config.maxSteps,
    dryRun: config.dryRun,
  });
  process.stdout.write(outcome.answer + '\n');
  process.stdout.write(`[session: ${outcome.sessionPath}]\n`);
}

main().catch((e: unknown) => {
  process.stderr.write(`mola: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
