// Tool registry with safety gates. Design rule (learned from the dsh
// prototype's bypassable denylist): an ALLOWLIST, not a denylist, plus
// workspace confinement. A bad call returns an error as a tool result —
// visible to the model — never a crash.

import { execFile } from 'node:child_process';
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolDef } from './providers.ts';

export interface ToolResult {
  ok: boolean;
  content: string;
}

export interface ToolContext {
  workspace: string;
}

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

export interface Tool {
  def: ToolDef;
  run: ToolHandler;
}

const MAX_READ_BYTES = 200_000;
const MAX_OUTPUT_CHARS = 20_000;
const BASH_TIMEOUT_MS = 10_000;
const BASH_ALLOWLIST = new Set(['ls', 'pwd', 'echo', 'wc', 'head', 'date', 'uname']);

function err(msg: string): ToolResult {
  return { ok: false, content: `error: ${msg}` };
}

function resolveInWorkspace(workspace: string, p: string): string | null {
  const root = path.resolve(workspace);
  const resolved = path.resolve(root, p);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

const readTool: Tool = {
  def: {
    name: 'read',
    description: 'Read a text file inside the workspace. Path is relative to the workspace root.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  run: async (args, ctx) => {
    if (typeof args.path !== 'string' || !args.path) return err('read needs a string path');
    const resolved = resolveInWorkspace(ctx.workspace, args.path);
    if (!resolved) return err(`path escapes the workspace: ${args.path}`);
    let size = 0;
    try {
      size = (await stat(resolved)).size;
    } catch {
      return err(`cannot stat file: ${args.path}`);
    }
    if (size > MAX_READ_BYTES) return err(`file too large (${size} bytes, cap ${MAX_READ_BYTES})`);
    try {
      const content = await readFile(resolved, 'utf8');
      return { ok: true, content: content.slice(0, MAX_OUTPUT_CHARS) };
    } catch {
      return err(`cannot read file: ${args.path}`);
    }
  },
};

const bashTool: Tool = {
  def: {
    name: 'bash',
    description:
      'Run one allowlisted command (ls, pwd, echo, wc, head, date, uname) in the workspace. No pipes, redirects, or shell metacharacters.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
  run: async (args, ctx) => {
    if (typeof args.command !== 'string' || !args.command.trim()) {
      return err('bash needs a non-empty command string');
    }
    const command = args.command.trim();
    // No shell, no metacharacters: split on whitespace only.
    if (/[|&;`$<>\n\r]/.test(command) || command.includes('$(') || command.includes('${')) {
      return err('bash refuses shell metacharacters (pipes, redirects, substitution)');
    }
    const parts = command.split(/\s+/);
    const name = parts[0];
    if (name.includes('/')) return err('bash needs a bare command name, not a path');
    if (!BASH_ALLOWLIST.has(name)) return err(`bash refuses non-allowlisted command: ${name}`);
    return new Promise<ToolResult>((resolve) => {
      execFile(
        name,
        parts.slice(1),
        { cwd: ctx.workspace, timeout: BASH_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_CHARS, shell: false },
        (error, stdout, stderr) => {
          const code = error ? ((error as { code?: unknown }).code ?? 1) : 0;
          const out = `exit: ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`;
          resolve({ ok: code === 0, content: out.slice(0, MAX_OUTPUT_CHARS) });
        },
      );
    });
  },
};

export const tools: Tool[] = [readTool, bashTool];

export function toolDefs(): ToolDef[] {
  return tools.map((t) => t.def);
}

export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = tools.find((t) => t.def.name === name);
  if (!tool) return err(`unknown tool: ${name}`);
  return tool.run(args, ctx);
}
