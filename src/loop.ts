// The agent loop: user message -> provider -> tool calls -> tool results
// -> repeat until final text or max steps. Every event is appended to a
// JSONL session log. API keys never appear in messages or in the log.
//
// v0.2 additions: permission decisions (allow/ask/deny, logged), lifecycle
// hooks (failures logged, never fatal), skills (progressive disclosure),
// MCP tools (schemas loaded from servers), subagents (isolated context),
// transcript compaction (deterministic summary, log untouched), graceful
// SIGINT (session_end marker), and malformed-argument safety.

import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Message, Provider, ToolDef } from './providers.ts';
import { tools as builtinTools, type Tool, type ToolContext, type ToolResult } from './tools.ts';
import { decidePermission } from './permissions.ts';
import type { PermissionRule } from './config.ts';
import type { McpServerConfig } from './config.ts';
import { runHook, type HookEvent } from './hooks.ts';
import { discoverSkills, skillsPromptSection, type Skill } from './skills.ts';
import { loadMcpTools } from './mcp.ts';
import { compactTranscript, transcriptChars, type CompactionConfig } from './compaction.ts';
import { sessionDir } from './session.ts';

const BASE_SYSTEM_PROMPT = [
  'You are mola, a minimal coding assistant.',
  'Use tools to gather facts first, then answer concisely.',
  'Never claim to have done something you did not do via a tool result.',
].join(' ');

export interface LoopOptions {
  provider: Provider;
  model: string;
  workspace: string;
  maxSteps: number;
  dryRun: boolean;
  yes: boolean;
  sandbox: boolean;
  permissions: Record<string, PermissionRule>;
  hooks: Record<string, string>;
  skillsDir: string;
  mcpServers: Record<string, McpServerConfig>;
  bashAllowlistExtra: string[];
  compaction: CompactionConfig;
  subagent: { maxDepth: number; maxSteps: number };
  depth?: number;
  sessionId?: string;
  parentSessionId?: string;
  resumeFrom?: string;
  forkFrom?: string;
  /** Replayed history (user/assistant/tool messages, no system message). */
  initialMessages?: Message[];
  /** New user message appended after replay (resume/fork follow-up). */
  followUp?: string;
  /** Asker for "ask" decisions; null = non-interactive; undefined = TTY default. */
  asker?: ((tool: string, args: Record<string, unknown>) => Promise<boolean>) | null;
}

export interface LoopOutcome {
  answer: string;
  sessionPath: string;
  sessionId: string;
  steps: number;
  interrupted: boolean;
}

function defaultAsker(): ((tool: string, args: Record<string, unknown>) => Promise<boolean>) | null {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  return async (tool, args) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise<boolean>((res) => {
      const onInt = (): void => {
        try {
          rl.close();
        } catch {
          // Already closed.
        }
        res(false);
      };
      process.once('SIGINT', onInt);
      rl.question(
        `mola: allow ${tool} ${JSON.stringify(args).slice(0, 300)}? [y/N] `,
        (ans) => {
          process.removeListener('SIGINT', onInt);
          const t = ans.trim().toLowerCase();
          res(t === 'y' || t === 'yes');
        },
      );
    });
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export async function runLoop(task: string, opts: LoopOptions): Promise<LoopOutcome> {
  const depth = opts.depth ?? 0;
  const sessionId = opts.sessionId ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const dir = sessionDir(opts.workspace);
  const sessionPath = path.join(dir, `${sessionId}.jsonl`);
  await mkdir(dir, { recursive: true });

  const log = async (event: Record<string, unknown>): Promise<void> => {
    await appendFile(sessionPath, JSON.stringify(event) + '\n', 'utf8');
  };

  let interrupted = false;
  let interruptWaiters: Array<() => void> = [];
  const onSigint = (): void => {
    interrupted = true;
    const waiters = interruptWaiters;
    interruptWaiters = [];
    for (const w of waiters) w();
  };
  process.on('SIGINT', onSigint);

  const runHookLogged = async (event: HookEvent): Promise<void> => {
    const cmd = opts.hooks[event.event];
    if (!cmd) return;
    const result = await runHook(cmd, { ...event, sessionId }, opts.workspace);
    await log({
      type: 'hook',
      event: event.event,
      tool: event.tool ?? null,
      ok: result.ok,
      timedOut: result.timedOut,
      code: result.code,
      stdout: result.stdout.slice(0, 500),
      stderr: result.stderr.slice(0, 500),
    });
  };

  let reason = 'max_steps';
  let outcome: LoopOutcome | null = null;
  let thrown: unknown = null;
  let closeMcp: (() => void) | null = null;

  try {
    await runHookLogged({ event: 'session:start' });

    const skills: Skill[] = await discoverSkills(opts.skillsDir);
    const mcp = await loadMcpTools(opts.mcpServers, async (msg) => {
      await log({ type: 'warning', warning: msg });
    });
    closeMcp = mcp.closeAll;

    let sandboxWarned = false;
    const toolCtx: ToolContext = {
      workspace: opts.workspace,
      bashAllowlistExtra: opts.bashAllowlistExtra,
      sandbox: opts.sandbox,
      skills,
      onSandboxFallback: () => {
        if (sandboxWarned) return;
        sandboxWarned = true;
        const msg = '--sandbox requested but bwrap is not available; falling back to process-level isolation (NOT a strong sandbox)';
        process.stderr.write(`mola: warning: ${msg}\n`);
        void log({ type: 'warning', warning: msg });
      },
    };

    // Tool registry: builtins + MCP tools + the subagent tool (depth-gated).
    const registry: Tool[] = [...builtinTools, ...mcp.tools];
    if (depth < opts.subagent.maxDepth) {
      const subagentTool: Tool = {
        def: {
          name: 'subagent',
          description:
            'Run a subagent with an isolated context (its own message history, a restricted tool subset, a step cap) on a subtask. ' +
            'Returns only a summary of what the subagent found or did.',
          parameters: {
            type: 'object',
            properties: { task: { type: 'string' }, maxSteps: { type: 'number' } },
            required: ['task'],
          },
        },
        run: async (args) => {
          if (typeof args.task !== 'string' || !args.task.trim()) {
            return { ok: false, content: 'error: subagent needs a non-empty task string' };
          }
          const childMaxSteps = Math.min(
            typeof args.maxSteps === 'number' && args.maxSteps > 0 ? Math.floor(args.maxSteps) : opts.subagent.maxSteps,
            opts.subagent.maxSteps,
          );
          const allowAll: Record<string, PermissionRule> = {};
          for (const t of builtinTools) allowAll[t.def.name] = 'allow';
          try {
            const child = await runLoop(args.task, {
              ...opts,
              provider: opts.provider,
              model: opts.model,
              maxSteps: childMaxSteps,
              depth: depth + 1,
              sessionId: undefined,
              parentSessionId: sessionId,
              resumeFrom: undefined,
              forkFrom: undefined,
              initialMessages: undefined,
              followUp: undefined,
              permissions: allowAll,
              hooks: {},
              mcpServers: {},
              asker: null,
              yes: true,
            });
            return { ok: true, content: `[subagent summary] ${child.answer.slice(0, 2000)}` };
          } catch (e) {
            return { ok: false, content: `error: subagent failed: ${e instanceof Error ? e.message : String(e)}` };
          }
        },
      };
      registry.push(subagentTool);
    }

    const defs: ToolDef[] = registry.map((t) => t.def);
    const asker = opts.asker !== undefined ? opts.asker : defaultAsker();

    const skillsSection = skillsPromptSection(skills);
    const systemPrompt = skillsSection ? `${BASE_SYSTEM_PROMPT}\n\n${skillsSection}` : BASE_SYSTEM_PROMPT;

    const messages: Message[] = [{ role: 'system', content: systemPrompt }];
    if (opts.initialMessages) messages.push(...opts.initialMessages);
    if (opts.resumeFrom) {
      await log({ type: 'resumed', from: opts.resumeFrom, task, parentSessionId: opts.parentSessionId ?? null });
    } else if (opts.forkFrom) {
      await log({ type: 'forked', from: opts.forkFrom, task, parentSessionId: opts.parentSessionId ?? null });
    } else if (opts.parentSessionId) {
      await log({ type: 'task', task, parentSessionId: opts.parentSessionId });
    } else {
      await log({ type: 'task', task });
    }
    if (opts.initialMessages === undefined) {
      messages.push({ role: 'user', content: task });
    }
    if (opts.followUp) {
      messages.push({ role: 'user', content: opts.followUp });
      await log({ type: 'task', task: opts.followUp, followUp: true });
    }

    let steps = 0;
    for (let step = 1; step <= opts.maxSteps; step++) {
      steps = step;
      if (interrupted) {
        reason = 'interrupted';
        break;
      }
      // Compaction: trim the live transcript, never the stored log.
      if (transcriptChars(messages) > opts.compaction.maxChars) {
        const compacted = compactTranscript(messages, opts.compaction);
        if (compacted.compacted) {
          messages.length = 0;
          messages.push(...compacted.messages);
          await log({
            type: 'compaction',
            removedMessages: compacted.removedMessages,
            summaryChars: compacted.summary.length,
          });
        }
      }
      let waiter: () => void = () => {};
      const interruptPromise = new Promise<null>((res) => {
        waiter = () => res(null);
        interruptWaiters.push(waiter);
      });
      const resultOrNull = await Promise.race([
        opts.provider.complete({ model: opts.model, messages, tools: defs }),
        interruptPromise,
      ]);
      interruptWaiters = interruptWaiters.filter((w) => w !== waiter);
      if (resultOrNull === null || interrupted) {
        reason = 'interrupted';
        break;
      }
      const result = resultOrNull;
      const assistant: Message = { role: 'assistant', content: result.text, toolCalls: result.toolCalls };
      messages.push(assistant);
      await log({ type: 'assistant', text: result.text, toolCalls: result.toolCalls });

      if (result.toolCalls.length === 0) {
        reason = 'answer';
        outcome = { answer: result.text, sessionPath, sessionId, steps: step, interrupted: false };
        break;
      }

      for (const call of result.toolCalls) {
        if (interrupted) break;
        const toolEntry = registry.find((t) => t.def.name === call.name);
        let toolResult: ToolResult;
        if (!toolEntry) {
          toolResult = { ok: false, content: `error: unknown tool: ${call.name}` };
        } else if (!isRecord(call.args) || (call.args as Record<string, unknown>).__malformed === true) {
          toolResult = { ok: false, content: 'error: malformed tool arguments (expected a JSON object)' };
        } else if (opts.dryRun) {
          toolResult = { ok: true, content: '[dry-run: not executed]' };
        } else {
          const decision = await decidePermission(call.name, call.args, opts.permissions, { yes: opts.yes, asker });
          await log({
            type: 'permission',
            tool: call.name,
            decision: decision.decision,
            rule: decision.rule,
            asked: decision.asked,
          });
          if (decision.decision === 'deny') {
            toolResult = { ok: false, content: `error: permission denied for tool ${call.name} (rule: ${decision.rule})` };
          } else {
            await runHookLogged({ event: 'before-tool', tool: call.name });
            toolResult = await toolEntry.run(call.args, toolCtx);
            await runHookLogged({ event: 'after-tool', tool: call.name, ok: toolResult.ok });
          }
        }
        messages.push({
          role: 'tool',
          content: toolResult.content,
          toolCallId: call.id,
          name: call.name,
        });
        await log({ type: 'tool_result', name: call.name, toolCallId: call.id, ok: toolResult.ok, content: toolResult.content });
      }
      if (interrupted) {
        reason = 'interrupted';
        break;
      }
    }

    if (!outcome) {
      if (reason === 'interrupted') {
        outcome = { answer: '(interrupted by user)', sessionPath, sessionId, steps, interrupted: true };
      } else {
        reason = 'max_steps';
        outcome = { answer: '(stopped at max steps without a final answer)', sessionPath, sessionId, steps, interrupted: false };
      }
    }
  } catch (e) {
    reason = 'error';
    thrown = e;
    try {
      await log({ type: 'provider_error', error: e instanceof Error ? e.message : String(e) });
    } catch {
      // Log write itself failed; nothing left to do.
    }
  } finally {
    try {
      await runHookLogged({ event: 'session:end' });
    } catch {
      // Hook failures never break the loop, including at teardown.
    }
    try {
      await log({ type: 'session_end', reason });
    } catch {
      // Best effort.
    }
    closeMcp?.();
    process.removeListener('SIGINT', onSigint);
  }

  if (thrown) throw thrown;
  return outcome as LoopOutcome;
}
