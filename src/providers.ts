// Provider abstraction: one narrow interface, two implementations.
// The mock provider is deterministic and network-free (used by the smoke
// test and the no-key quickstart). The OpenAI-compatible provider talks to
// any chat-completions endpoint (DeepSeek preset or custom base URL).

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

/** Any OpenAI-compatible chat-completions endpoint (DeepSeek, custom). */
export class OpenAICompatibleProvider implements Provider {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  async complete(req: {
    model: string;
    messages: Message[];
    tools: ToolDef[];
  }): Promise<ProviderResult> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages.map(toOpenAIMessage),
        tools: req.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
        tool_choice: 'auto',
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 500);
      throw new Error(`provider request failed: HTTP ${res.status}: ${body}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
    };
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error('provider returned no choices');
    const toolCalls: ToolCall[] = [];
    for (const c of msg.tool_calls ?? []) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(c.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        args = {};
      }
      toolCalls.push({ id: c.id, name: c.function.name, args });
    }
    return { text: msg.content ?? '', toolCalls };
  }
}
