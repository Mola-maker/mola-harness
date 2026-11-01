// Tool registry with safety gates. Design rule (learned from the dsh
// prototype's bypassable denylist): an ALLOWLIST, not a denylist, plus
// workspace confinement. A bad call returns an error as a tool result —
// visible to the model — never a crash.
//
// v0.2 tools: read, write (ask by default), glob, grep, bash (allowlist,
// extendable via mola.json, scrubbed env, optional bwrap), skill.

import { execFile } from 'node:child_process';
import { readdir, stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { ToolDef } from './providers.ts';
import type { Skill } from './skills.ts';
import { bwrapPrefix } from './sandbox.ts';

export interface ToolResult {
  ok: boolean;
  content: string;
}

export interface ToolContext {
  workspace: string;
  bashAllowlistExtra?: string[];
  sandbox?: boolean;
  /** Called once when --sandbox falls back (bwrap missing). */
  onSandboxFallback?: () => void;
  skills?: Skill[];
}

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

export interface Tool {
  def: ToolDef;
  run: ToolHandler;
}

const MAX_READ_BYTES = 200_000;
const MAX_WRITE_CHARS = 200_000;
const MAX_OUTPUT_CHARS = 20_000;
const BASH_TIMEOUT_MS = 10_000;
const BASH_DEFAULT_ALLOWLIST = ['ls', 'pwd', 'echo', 'wc', 'head', 'date', 'uname'];
const GLOB_MAX_RESULTS = 200;
const GREP_MAX_MATCHES = 100;

function err(msg: string): ToolResult {
  return { ok: false, content: `error: ${msg}` };
}

function resolveInWorkspace(workspace: string, p: string): string | null {
  const root = path.resolve(workspace);
  const resolved = path.resolve(root, p);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

/** Minimal env for child processes: PATH + locale/timezone only. */
export function scrubbedEnv(): Record<string, string> {
  const keep = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TERM'];
  const out: Record<string, string> = {};
  for (const k of keep) {
    if (process.env[k] !== undefined) out[k] = process.env[k] as string;
  }
  return out;
}

function isTextFile(buf: Buffer): boolean {
  // Binary sniff: a NUL byte in the first 8 KiB means "not text".
  return !buf.subarray(0, 8192).includes(0);
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

const writeTool: Tool = {
  def: {
    name: 'write',
    description:
      'Write a text file inside the workspace (creates parent directories). ' +
      'Path is relative to the workspace root. Never write under .mola/.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  run: async (args, ctx) => {
    if (typeof args.path !== 'string' || !args.path) return err('write needs a string path');
    if (typeof args.content !== 'string') return err('write needs a string content');
    if (args.content.length > MAX_WRITE_CHARS) {
      return err(`content too large (${args.content.length} chars, cap ${MAX_WRITE_CHARS})`);
    }
    const rel = path.normalize(args.path);
    if (rel === '.mola' || rel.startsWith(`.mola${path.sep}`)) {
      return err('write refuses paths under .mola/ (session state)');
    }
    const resolved = resolveInWorkspace(ctx.workspace, args.path);
    if (!resolved) return err(`path escapes the workspace: ${args.path}`);
    try {
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, args.content, 'utf8');
      return { ok: true, content: `wrote ${args.content.length} chars to ${args.path}` };
    } catch {
      return err(`cannot write file: ${args.path}`);
    }
  },
};

function globToRegExp(pattern: string): RegExp {
  // Supports ** (any depth), * (within a segment), ? (one char).
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // ** consumes slashes too; an optional trailing slash follows.
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(re + '$');
}

async function walkFiles(root: string, dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.name === '.mola' || e.name === 'node_modules' || e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walkFiles(root, full, out);
    else if (e.isFile()) out.push(path.relative(root, full));
  }
}

const globTool: Tool = {
  def: {
    name: 'glob',
    description:
      'List files in the workspace matching a glob pattern (*, **, ?). ' +
      'Results are workspace-relative paths, sorted, capped.',
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string' } },
      required: ['pattern'],
    },
  },
  run: async (args, ctx) => {
    if (typeof args.pattern !== 'string' || !args.pattern) return err('glob needs a string pattern');
    const root = path.resolve(ctx.workspace);
    const all: string[] = [];
    await walkFiles(root, root, all);
    const re = globToRegExp(args.pattern);
    const matched = all.filter((p) => re.test(p)).slice(0, GLOB_MAX_RESULTS);
    return { ok: true, content: matched.join('\n') || '(no matches)' };
  },
};

const grepTool: Tool = {
  def: {
    name: 'grep',
    description:
      'Search file contents in the workspace for a regex. Optional path scopes ' +
      'the search to one file or directory (relative to the workspace root).',
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string' }, path: { type: 'string' } },
      required: ['pattern'],
    },
  },
  run: async (args, ctx) => {
    if (typeof args.pattern !== 'string' || !args.pattern) return err('grep needs a string pattern');
    let re: RegExp;
    try {
      re = new RegExp(args.pattern);
    } catch {
      return err(`invalid regex: ${args.pattern}`);
    }
    const root = path.resolve(ctx.workspace);
    let scope = root;
    if (typeof args.path === 'string' && args.path) {
      const resolved = resolveInWorkspace(ctx.workspace, args.path);
      if (!resolved) return err(`path escapes the workspace: ${args.path}`);
      scope = resolved;
    }
    let files: string[] = [];
    try {
      const st = await stat(scope);
      if (st.isFile()) files = [scope];
      else {
        const rel: string[] = [];
        await walkFiles(root, scope, rel);
        files = rel.map((p) => path.join(root, p));
      }
    } catch {
      return err(`cannot search path: ${args.path ?? '.'}`);
    }
    const matches: string[] = [];
    for (const file of files.sort()) {
      if (matches.length >= GREP_MAX_MATCHES) break;
      let buf: Buffer;
      try {
        const size = (await stat(file)).size;
        if (size > MAX_READ_BYTES) continue;
        buf = await readFile(file);
      } catch {
        continue;
      }
      if (!isTextFile(buf)) continue;
      const lines = buf.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          matches.push(`${path.relative(root, file)}:${i + 1}: ${lines[i].slice(0, 200)}`);
          if (matches.length >= GREP_MAX_MATCHES) break;
        }
      }
    }
    return { ok: true, content: matches.join('\n') || '(no matches)' };
  },
};

const bashTool: Tool = {
  def: {
    name: 'bash',
    description:
      'Run one allowlisted command in the workspace. No pipes, redirects, or shell metacharacters. ' +
      'Default allowlist: ls, pwd, echo, wc, head, date, uname (extendable via mola.json bashAllowlist).',
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
    if (/[|&;`$<>\n\r]/.test(command) || command.includes('$(') || command.includes('${')) {
      return err('bash refuses shell metacharacters (pipes, redirects, substitution)');
    }
    const parts = command.split(/\s+/);
    const name = parts[0];
    if (name.includes('/')) return err('bash needs a bare command name, not a path');
    const allowlist = new Set([...BASH_DEFAULT_ALLOWLIST, ...(ctx.bashAllowlistExtra ?? [])]);
    if (!allowlist.has(name)) return err(`bash refuses non-allowlisted command: ${name}`);
    const env = scrubbedEnv();
    let argv: string[];
    let bin: string;
    if (ctx.sandbox) {
      const prefix = bwrapPrefix(ctx.workspace, env.PATH);
      if (prefix) {
        bin = 'bwrap';
        argv = [...prefix, name, ...parts.slice(1)];
      } else {
        ctx.onSandboxFallback?.();
        bin = name;
        argv = parts.slice(1);
      }
    } else {
      bin = name;
      argv = parts.slice(1);
    }
    return new Promise<ToolResult>((resolve) => {
      execFile(
        bin,
        argv,
        { cwd: ctx.workspace, timeout: BASH_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_CHARS, shell: false, env },
        (error, stdout, stderr) => {
          const code = error ? ((error as { code?: unknown }).code ?? 1) : 0;
          const out = `exit: ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`;
          resolve({ ok: code === 0, content: out.slice(0, MAX_OUTPUT_CHARS) });
        },
      );
    });
  },
};

const skillTool: Tool = {
  def: {
    name: 'skill',
    description:
      'Load the full body of a skill by name (progressive disclosure: the system prompt only lists skill names and one-line descriptions).',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  run: async (args, ctx) => {
    if (typeof args.name !== 'string' || !args.name) return err('skill needs a string name');
    const skill = (ctx.skills ?? []).find((s) => s.name === args.name);
    if (!skill) return err(`unknown skill: ${args.name}`);
    try {
      const body = await readFile(skill.path, 'utf8');
      return { ok: true, content: body.slice(0, MAX_OUTPUT_CHARS) };
    } catch {
      return err(`cannot read skill: ${args.name}`);
    }
  },
};

export const tools: Tool[] = [readTool, writeTool, globTool, grepTool, bashTool, skillTool];

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

export { BASH_DEFAULT_ALLOWLIST };
