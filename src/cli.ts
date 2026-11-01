#!/usr/bin/env node
// mola CLI (v0.2):
//   node src/cli.ts run "task" [options]
//   node src/cli.ts resume <session-id> ["follow-up task"] [options]
//   node src/cli.ts fork <session-id> ["follow-up task"] [options]
//   node src/cli.ts sessions
// No install step: zero dependencies, run with Node >= 22 (type-stripping).

import path from 'node:path';
import { loadConfig } from './config.ts';
import { MockProvider, OpenAICompatibleProvider } from './providers.ts';
import type { Provider } from './providers.ts';
import { runLoop } from './loop.ts';
import { listSessions, replaySession } from './session.ts';

const VERSION = '0.2.0';

const HELP = `mola-harness v${VERSION} — a minimal agent harness for individual developers

Usage:
  node src/cli.ts run "task" [options]
  node src/cli.ts resume <session-id> ["follow-up task"] [options]
  node src/cli.ts fork <session-id> ["follow-up task"] [options]
  node src/cli.ts sessions [options]

Options:
  --provider mock|deepseek|custom   (default: mock, or MOLA_PROVIDER / mola.json)
  --model MODEL                     (default: deepseek-chat for deepseek, mock for mock)
  --workspace DIR                   (default: current directory, or MOLA_WORKSPACE)
  --max-steps N                     (default: 10, or MOLA_MAX_STEPS / mola.json)
  --dry-run                         print planned tool calls without executing them
  --yes                             treat "ask" permissions as allowed
  --sandbox                         run bash via bwrap when available (warn + fall back otherwise)
  --help                            show this help

Config file (mola.json): <workspace>/.mola/mola.json overrides
~/.config/mola/mola.json; CLI flags override env vars, which override the
project file, which overrides the user file. Config files must never
contain secrets — keys come from the environment only:
  MOLA_API_KEY (or DEEPSEEK_API_KEY for the deepseek preset)
  MOLA_BASE_URL (required for the custom preset)

Examples:
  node src/cli.ts run "read package.json and tell me its name" --provider mock
  DEEPSEEK_API_KEY=... node src/cli.ts run "summarize README.md" --provider deepseek
  node src/cli.ts sessions
  node src/cli.ts resume 2026-11-01T08-00-00-000Z-12345 --max-steps 20
`;

interface Parsed {
  command: string;
  task: string;
  sessionId: string;
  overrides: Record<string, string | number | boolean>;
}

function parseArgs(argv: string[]): Parsed {
  const args = [...argv];
  if (args[0] === '--help' || args[0] === '-h' || args.length === 0) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const command = args.shift() as string;
  if (command !== 'run' && command !== 'resume' && command !== 'fork' && command !== 'sessions') {
    throw new Error(`unknown command: ${command} (expected run, resume, fork, or sessions; see --help)`);
  }
  const overrides: Record<string, string | number | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--provider' || a === '--model' || a === '--workspace' || a === '--max-steps') {
      const v = args[++i];
      if (v === undefined) throw new Error(`flag ${a} needs a value`);
      overrides[a.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] =
        a === '--max-steps' ? Number(v) : v;
    } else if (a === '--dry-run') {
      overrides.dryRun = true;
    } else if (a === '--yes') {
      overrides.yes = true;
    } else if (a === '--sandbox') {
      overrides.sandbox = true;
    } else if (a.startsWith('--')) {
      throw new Error(`unknown flag: ${a} (see --help)`);
    } else {
      positionals.push(a);
    }
  }
  if (command === 'sessions') {
    return { command, task: '', sessionId: '', overrides };
  }
  if (command === 'run') {
    const task = positionals.join(' ').trim();
    if (!task) throw new Error('run needs a task string');
    return { command, task, sessionId: '', overrides };
  }
  // resume / fork: first positional is the session id, rest is follow-up.
  const sessionId = positionals[0];
  if (!sessionId) throw new Error(`${command} needs a session id (see "sessions")`);
  return { command, task: positionals.slice(1).join(' ').trim(), sessionId, overrides };
}

async function buildProvider(config: ReturnType<typeof loadConfig>): Promise<Provider> {
  if (config.provider === 'mock') return new MockProvider();
  return new OpenAICompatibleProvider(config.baseUrl as string, config.apiKey as string, {
    timeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
  });
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const config = loadConfig({
    provider: parsed.overrides.provider as string | undefined,
    model: parsed.overrides.model as string | undefined,
    workspace: parsed.overrides.workspace as string | undefined,
    maxSteps: parsed.overrides.maxSteps as number | undefined,
    dryRun: parsed.overrides.dryRun as boolean | undefined,
    yes: parsed.overrides.yes as boolean | undefined,
    sandbox: parsed.overrides.sandbox as boolean | undefined,
  });
  const workspace = path.resolve(config.workspace);

  if (parsed.command === 'sessions') {
    const sessions = await listSessions(workspace);
    if (sessions.length === 0) {
      process.stdout.write(`(no sessions in ${path.join(workspace, '.mola', 'sessions')})\n`);
      return;
    }
    for (const s of sessions) {
      process.stdout.write(`${s.id}  ${s.events} events  last=${s.lastType}  ${s.task.slice(0, 80)}\n`);
    }
    return;
  }

  const provider = await buildProvider(config);
  const baseOpts = {
    provider,
    model: config.model,
    workspace,
    maxSteps: config.maxSteps,
    dryRun: config.dryRun,
    yes: config.yes,
    sandbox: config.sandbox,
    permissions: config.permissions,
    hooks: config.hooks,
    skillsDir: path.isAbsolute(config.skillsDir) ? config.skillsDir : path.join(workspace, config.skillsDir),
    mcpServers: config.mcpServers,
    bashAllowlistExtra: config.bashAllowlist,
    compaction: config.compaction,
    subagent: config.subagent,
  };

  let outcome;
  if (parsed.command === 'run') {
    outcome = await runLoop(parsed.task, baseOpts);
  } else {
    const replay = await replaySession(workspace, parsed.sessionId);
    const alreadyAnswered = replay.lastEndReason === 'answer' || replay.lastType === 'answer';
    if (alreadyAnswered && !parsed.task) {
      process.stdout.write(`session ${parsed.sessionId} already ended with an answer; pass a follow-up task to continue it.\n`);
      return;
    }
    outcome = await runLoop(replay.task, {
      ...baseOpts,
      resumeFrom: parsed.command === 'resume' ? parsed.sessionId : undefined,
      forkFrom: parsed.command === 'fork' ? parsed.sessionId : undefined,
      initialMessages: replay.messages,
      followUp: parsed.task || undefined,
    });
  }
  process.stdout.write(outcome.answer + '\n');
  process.stdout.write(`[session: ${outcome.sessionPath}]\n`);
  if (outcome.interrupted) process.exit(130);
}

main().catch((e: unknown) => {
  process.stderr.write(`mola: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
