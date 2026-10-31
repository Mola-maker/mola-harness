// The agent loop: user message -> provider -> tool calls -> tool results
// -> repeat until final text or max steps. Every event is appended to a
// JSONL session log. API keys never appear in messages or in the log.

import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Message, Provider } from './providers.ts';
import { runTool, toolDefs } from './tools.ts';

const SYSTEM_PROMPT = [
  'You are mola, a minimal coding assistant.',
  'You have two tools: read (read a file in the workspace) and bash (run an allowlisted command in the workspace).',
  'Use tools to gather facts first, then answer concisely.',
  'Never claim to have done something you did not do via a tool result.',
].join(' ');

export interface LoopOptions {
  provider: Provider;
  model: string;
  workspace: string;
  maxSteps: number;
  dryRun: boolean;
}

export interface LoopOutcome {
  answer: string;
  sessionPath: string;
  steps: number;
}

export async function runLoop(task: string, opts: LoopOptions): Promise<LoopOutcome> {
  const sessionId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const sessionDir = path.join(opts.workspace, '.mola', 'sessions');
  const sessionPath = path.join(sessionDir, `${sessionId}.jsonl`);
  await mkdir(sessionDir, { recursive: true });

  const log = async (event: Record<string, unknown>): Promise<void> => {
    await appendFile(sessionPath, JSON.stringify(event) + '\n', 'utf8');
  };

  const messages: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: task },
  ];
  await log({ type: 'task', task });

  for (let step = 1; step <= opts.maxSteps; step++) {
    const result = await opts.provider.complete({
      model: opts.model,
      messages,
      tools: toolDefs(),
    });
    const assistant: Message = { role: 'assistant', content: result.text, toolCalls: result.toolCalls };
    messages.push(assistant);
    await log({ type: 'assistant', text: result.text, toolCalls: result.toolCalls });

    if (result.toolCalls.length === 0) {
      await log({ type: 'answer', answer: result.text });
      return { answer: result.text, sessionPath, steps: step };
    }

    for (const call of result.toolCalls) {
      const toolResult = opts.dryRun
        ? { ok: true, content: '[dry-run: not executed]' }
        : await runTool(call.name, call.args, { workspace: opts.workspace });
      messages.push({
        role: 'tool',
        content: toolResult.content,
        toolCallId: call.id,
        name: call.name,
      });
      await log({ type: 'tool_result', name: call.name, ok: toolResult.ok, content: toolResult.content });
    }
  }

  const answer = '(stopped at max steps without a final answer)';
  await log({ type: 'answer', answer });
  return { answer, sessionPath, steps: opts.maxSteps };
}
