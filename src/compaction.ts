// Compaction: when the live transcript exceeds a character budget
// (chars/4 as a token estimate), compress old turns into one summary
// message and keep the system prompt + the most recent turns. The summary
// is deterministic (first lines of compacted turns, truncated) — no model
// call, so it works identically under the mock provider. The stored
// session log is never touched: compaction only trims what is sent to
// the provider next, so no session history is ever lost.

import type { Message } from './providers.ts';

export interface CompactionConfig {
  maxChars: number;
  keepMessages: number;
}

export function transcriptChars(messages: Message[]): number {
  let n = 0;
  for (const m of messages) {
    n += m.content.length;
    for (const c of m.toolCalls ?? []) n += c.name.length + JSON.stringify(c.args).length;
  }
  return n;
}

export interface CompactionResult {
  messages: Message[];
  compacted: boolean;
  removedMessages: number;
  summary: string;
}

function summarizeTurn(m: Message): string {
  const first = m.content.replace(/\s+/g, ' ').slice(0, 120);
  const tools = (m.toolCalls ?? []).map((c) => c.name).join(',');
  if (m.role === 'tool') return `[tool ${m.name ?? ''}] ${first}`;
  if (m.role === 'assistant' && tools) return `[assistant calls ${tools}] ${first}`;
  return `[${m.role}] ${first}`;
}

export function compactTranscript(messages: Message[], cfg: CompactionConfig): CompactionResult {
  if (messages.length < 2 || transcriptChars(messages) <= cfg.maxChars) {
    return { messages, compacted: false, removedMessages: 0, summary: '' };
  }
  const system = messages[0];
  const rest = messages.slice(1);
  // Keep the most recent turns, but always summarize at least one old
  // turn when over budget — otherwise a short transcript with one huge
  // message would never compact at all.
  let keepCount = cfg.keepMessages;
  if (rest.length - keepCount < 1) keepCount = rest.length - 1;
  if (keepCount < 0) {
    return { messages, compacted: false, removedMessages: 0, summary: '' };
  }
  const keep = keepCount > 0 ? rest.slice(-keepCount) : [];
  const removed = rest.slice(0, rest.length - keep.length);
  const summaryBody = removed.map(summarizeTurn).join('\n').slice(0, 2000);
  const summary =
    `Earlier conversation compacted (${removed.length} messages summarized deterministically; ` +
    `full history remains in the session log):\n${summaryBody}`;
  const compacted: Message[] = [
    system,
    { role: 'system', content: summary },
    ...keep,
  ];
  return { messages: compacted, compacted: true, removedMessages: removed.length, summary };
}
