// Session store: list and replay JSONL session logs under
// <workspace>/.mola/sessions/. Replay rebuilds the provider message
// history so `resume`/`fork` continue exactly where a run stopped.
// The full log is never rewritten — compaction only affects the live
// in-memory transcript, never the stored history.

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Message } from './providers.ts';

export interface SessionInfo {
  id: string;
  task: string;
  events: number;
  lastType: string;
  mtimeMs: number;
}

export function sessionDir(workspace: string): string {
  return path.join(workspace, '.mola', 'sessions');
}

export async function listSessions(workspace: string): Promise<SessionInfo[]> {
  const dir = sessionDir(workspace);
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort();
  } catch {
    return [];
  }
  const out: SessionInfo[] = [];
  for (const file of files) {
    const full = path.join(dir, file);
    let text = '';
    let mtimeMs = 0;
    try {
      text = await readFile(full, 'utf8');
      mtimeMs = (await stat(full)).mtimeMs;
    } catch {
      continue;
    }
    const events = text.split('\n').filter(Boolean);
    let task = '(unknown task)';
    let lastType = '(empty)';
    for (const line of events) {
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof ev.type === 'string') lastType = ev.type;
      if (ev.type === 'task' && typeof ev.task === 'string') task = ev.task;
      if (ev.type === 'resumed' && typeof ev.task === 'string') task = ev.task;
    }
    out.push({ id: file.slice(0, -'.jsonl'.length), task, events: events.length, lastType, mtimeMs });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

export async function findSessionFile(workspace: string, id: string): Promise<string> {
  const dir = sessionDir(workspace);
  const exact = path.join(dir, `${id}.jsonl`);
  try {
    await stat(exact);
    return exact;
  } catch {
    // Fall through to prefix match.
  }
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    files = [];
  }
  const matches = files.filter((f) => f.startsWith(id));
  if (matches.length === 1) return path.join(dir, matches[0]);
  if (matches.length > 1) {
    throw new Error(`ambiguous session id "${id}": matches ${matches.map((f) => f.slice(0, -5)).join(', ')}`);
  }
  throw new Error(`no session found for id "${id}" in ${dir}`);
}

export interface ReplayResult {
  messages: Message[];
  task: string;
  lastType: string;
  /** Reason of the trailing session_end event, when present. */
  lastEndReason?: string;
}

/** Rebuild provider messages from a session log. */
export async function replaySession(workspace: string, id: string): Promise<ReplayResult> {
  const file = await findSessionFile(workspace, id);
  const text = await readFile(file, 'utf8');
  const messages: Message[] = [];
  let task = '';
  let lastType = '';
  let lastEndReason: string | undefined;
  let toolCounter = 0;
  for (const line of text.split('\n').filter(Boolean)) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof ev.type === 'string') lastType = ev.type;
    if (ev.type === 'session_end' && typeof ev.reason === 'string') lastEndReason = ev.reason;
    if (ev.type === 'task' && typeof ev.task === 'string') {
      task = ev.task;
      messages.push({ role: 'user', content: ev.task });
    } else if (ev.type === 'assistant') {
      const toolCalls = Array.isArray(ev.toolCalls)
        ? (ev.toolCalls as { id?: unknown; name?: unknown; args?: unknown }[])
            .filter((c) => typeof c.name === 'string')
            .map((c) => ({
              id: typeof c.id === 'string' ? c.id : `replayed-${toolCounter++}`,
              name: c.name as string,
              args: (c.args ?? {}) as Record<string, unknown>,
            }))
        : [];
      messages.push({
        role: 'assistant',
        content: typeof ev.text === 'string' ? ev.text : '',
        toolCalls,
      });
    } else if (ev.type === 'tool_result') {
      toolCounter++;
      messages.push({
        role: 'tool',
        content: typeof ev.content === 'string' ? ev.content : '',
        toolCallId: typeof ev.toolCallId === 'string' ? ev.toolCallId : `replayed-${toolCounter}`,
        name: typeof ev.name === 'string' ? ev.name : undefined,
      });
    }
    // task/answer/compaction/permission/hook/session_end events carry no
    // provider message and are skipped on replay.
  }
  return { messages, task, lastType, lastEndReason };
}
