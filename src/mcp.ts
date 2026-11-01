// MCP host (client side): speaks JSON-RPC 2.0 over a server's stdio.
// Schemas are loaded from the server on demand (tools/list at session
// start, cached per session) — never bundled. Calls carry a timeout, and
// every failure is returned as a tool result so the model sees it.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { McpServerConfig } from './config.ts';
import type { Tool, ToolResult } from './tools.ts';
import { scrubbedEnv } from './tools.ts';

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface Pending {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_TIMEOUT_MS = 30_000;

export class McpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = '';
  private toolsCache: McpToolDef[] | null = null;
  readonly serverName: string;

  private cfg: McpServerConfig;

  constructor(serverName: string, cfg: McpServerConfig) {
    this.serverName = serverName;
    this.cfg = cfg;
  }

  start(): void {
    if (this.child) return;
    const env = { ...scrubbedEnv(), ...(this.cfg.env ?? {}) };
    this.child = spawn(this.cfg.command, this.cfg.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      shell: false,
    });
    this.child.stdout.on('data', (chunk: Buffer) => this.onData(chunk.toString('utf8')));
    this.child.stderr.on('data', () => {
      // Server diagnostics: ignored by design (stdout is the protocol).
    });
    this.child.on('error', (err) => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`MCP server "${this.serverName}" failed to start: ${err.message}`));
      }
      this.pending.clear();
    });
    this.child.on('exit', () => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`MCP server "${this.serverName}" exited`));
      }
      this.pending.clear();
    });
  }

  private onData(text: string): void {
    this.buffer += text;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const id = msg.id;
      if (typeof id === 'number' && this.pending.has(id)) {
        const p = this.pending.get(id) as Pending;
        this.pending.delete(id);
        clearTimeout(p.timer);
        if (msg.error) {
          const e = msg.error as { message?: string };
          p.reject(new Error(`MCP error: ${e.message ?? JSON.stringify(msg.error)}`));
        } else {
          p.resolve((msg.result ?? {}) as Record<string, unknown>);
        }
      }
      // Notifications and responses without a pending id are ignored.
    }
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    if (!this.child) throw new Error(`MCP server "${this.serverName}" is not started`);
    const id = this.nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child?.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.child?.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async initialize(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
    this.start();
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'mola-harness', version: '0.2.0' },
    }, timeoutMs);
    this.notify('notifications/initialized', {});
  }

  async listTools(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<McpToolDef[]> {
    if (this.toolsCache) return this.toolsCache;
    const result = await this.request('tools/list', {}, timeoutMs);
    const raw = result.tools;
    if (!Array.isArray(raw)) throw new Error(`MCP server "${this.serverName}" returned no tools list`);
    const tools: McpToolDef[] = [];
    for (const t of raw) {
      const entry = t as { name?: unknown; description?: unknown; inputSchema?: unknown };
      if (typeof entry.name !== 'string') continue;
      tools.push({
        name: entry.name,
        description: typeof entry.description === 'string' ? entry.description : '',
        inputSchema: (entry.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
      });
    }
    this.toolsCache = tools;
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ToolResult> {
    const result = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    const content = result.content;
    let text = '';
    if (Array.isArray(content)) {
      text = content
        .map((c) => {
          const part = c as { type?: string; text?: string };
          return part.type === 'text' && typeof part.text === 'string' ? part.text : JSON.stringify(c);
        })
        .join('\n');
    } else if (typeof content === 'string') {
      text = content;
    }
    const isError = result.isError === true;
    return { ok: !isError, content: isError ? `error: ${text || 'MCP tool reported an error'}` : text };
  }

  close(): void {
    try {
      this.child?.stdin.end();
      this.child?.kill('SIGTERM');
    } catch {
      // Already gone.
    }
    this.child = null;
  }
}

/**
 * Start every configured server, list its tools, and expose each remote
 * tool as `mcp_<server>_<tool>`. A server that fails to initialize or
 * list is skipped with a warning — it never breaks the loop. Callers
 * must call closeAll() when done.
 */
export async function loadMcpTools(
  servers: Record<string, McpServerConfig>,
  warn: (msg: string) => Promise<void> | void,
): Promise<{ tools: Tool[]; closeAll: () => void }> {
  const tools: Tool[] = [];
  const clients: McpClient[] = [];
  for (const [serverName, cfg] of Object.entries(servers)) {
    const client = new McpClient(serverName, cfg);
    try {
      await client.initialize();
      const defs = await client.listTools();
      for (const def of defs) {
        const toolName = `mcp_${serverName}_${def.name}`;
        tools.push({
          def: { name: toolName, description: `[MCP ${serverName}] ${def.description}`, parameters: def.inputSchema },
          run: async (args) => {
            try {
              return await client.callTool(def.name, args);
            } catch (e) {
              return { ok: false, content: `error: ${e instanceof Error ? e.message : String(e)}` };
            }
          },
        });
      }
      clients.push(client);
    } catch (e) {
      await warn(`MCP server "${serverName}" unavailable, skipping: ${e instanceof Error ? e.message : String(e)}`);
      client.close();
    }
  }
  return {
    tools,
    closeAll: () => {
      for (const c of clients) c.close();
    },
  };
}
