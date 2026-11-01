// Provider abstraction: one narrow interface, two implementations.
// The mock provider is deterministic and network-free (used by the tests
// and the no-key quickstart). The OpenAI-compatible provider talks to any
// chat-completions endpoint (DeepSeek preset or custom base URL) with
// backoff retries on 429/5xx (honoring Retry-After), a configurable
// request timeout, and malformed tool-argument handling that never
// crashes the loop.

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ProviderResult {
  text: string;
  toolCalls: ToolCall[];
}

export interface Provider {
  complete(req: { model: string; messages: Message[]; tools: ToolDef[] }): Promise<ProviderResult>;
}

function hasToolResult(messages: Message[]): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'tool') return messages[i];
  }
  return undefined;
}

function pickPathFromTask(task: string): string {
  const m = task.match(/[A-Za-z0-9_./-]+\.(json|md|txt|ts|js|mjs)/);
  return m ? m[0] : 'package.json';
}

/** Deterministic scripted provider. Proves the loop, tools, and session log. */
export class MockProvider implements Provider {
  async complete(req: { messages: Message[] }): Promise<ProviderResult> {
    const done = hasToolResult(req.messages);
    if (done) {
      const flat = done.content.replace(/\s+/g, ' ').slice(0, 200);
      return { text: `Done. I read the file. It contains: ${flat}`, toolCalls: [] };
    }
    const task = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    return {
      text: '',
      toolCalls: [{ id: 'mock-call-1', name: 'read', args: { path: pickPathFromTask(task) } }],
    };
  }
}

interface OpenAIChatMessage {
  role: string;
  content: string | null;
  tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
}

function toOpenAIMessage(m: Message): OpenAIChatMessage {
  if (m.role === 'assistant') {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: (m.toolCalls ?? []).map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args) },
      })),
    };
  }
  if (m.role === 'tool') {
    return { role: 'tool', content: m.content, tool_call_id: m.toolCallId ?? '', name: m.name };
  }
  return { role: m.role, content: m.content };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 60) * 1000;
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Any OpenAI-compatible chat-completions endpoint (DeepSeek, custom). */
export class OpenAICompatibleProvider implements Provider {
  private baseUrl: string;
  private apiKey: string;
  private timeoutMs: number;
  private maxRetries: number;

  constructor(
    baseUrl: string,
    apiKey: string,
    opts?: { timeoutMs?: number; maxRetries?: number },
  ) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.timeoutMs = opts?.timeoutMs ?? 120_000;
    this.maxRetries = opts?.maxRetries ?? 3;
  }

  async complete(req: {
    model: string;
    messages: Message[];
    tools: ToolDef[];
  }): Promise<ProviderResult> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const body = JSON.stringify({
      model: req.model,
      messages: req.messages.map(toOpenAIMessage),
      tools: req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      tool_choice: 'auto',
    });
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        // Network error or timeout: retry with backoff, then give up.
        lastError = e instanceof Error ? e : new Error(String(e));
        if (attempt < this.maxRetries) await sleep(Math.min(1000 * 2 ** attempt, 30_000));
        continue;
      }
      if (res.ok) {
        let data: unknown;
        try {
          data = await res.json();
        } catch {
          throw new Error('provider returned invalid JSON');
        }
        const msg = (data as { choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[] }).choices?.[0]?.message;
        if (!msg) throw new Error('provider returned no choices');
        const toolCalls: ToolCall[] = [];
        for (const c of msg.tool_calls ?? []) {
          if (!c || typeof c.function?.name !== 'string' || !c.function.name) continue;
          let args: unknown = {};
          try {
            args = JSON.parse(c.function.arguments || '{}');
          } catch {
            args = {};
          }
          // Malformed (non-object) arguments never crash the loop: the
          // loop reports them as a tool error instead.
          if (!isRecord(args)) args = { __malformed: true, __raw: String(c.function.arguments ?? '').slice(0, 500) };
          toolCalls.push({ id: typeof c.id === 'string' ? c.id : `call-${toolCalls.length}`, name: c.function.name, args: args as Record<string, unknown> });
        }
        return { text: msg.content ?? '', toolCalls };
      }
      const retryable = res.status === 429 || res.status >= 500;
      const text = (await res.text().catch(() => '')).slice(0, 500);
      lastError = new Error(`provider request failed: HTTP ${res.status}: ${text}`);
      if (!retryable || attempt === this.maxRetries) throw lastError;
      const wait = parseRetryAfter(res.headers.get('Retry-After'))
        ?? Math.min(1000 * 2 ** attempt, 30_000);
      await sleep(wait);
    }
    throw lastError ?? new Error('provider request failed');
  }
}
