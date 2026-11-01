// Config: two-level mola.json (user, then project) under CLI > env >
// project > user > defaults. API keys NEVER come from config files —
// only from the environment. An invalid config file is a loud, specific
// error (file + key + expected shape), never a silent fallback.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export type ProviderName = 'mock' | 'deepseek' | 'custom';
export type PermissionRule = 'allow' | 'ask' | 'deny';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface Config {
  provider: ProviderName;
  model: string;
  apiKey: string | null;
  baseUrl: string | null;
  workspace: string;
  maxSteps: number;
  dryRun: boolean;
  yes: boolean;
  sandbox: boolean;
  requestTimeoutMs: number;
  maxRetries: number;
  permissions: Record<string, PermissionRule>;
  hooks: Record<string, string>;
  bashAllowlist: string[];
  mcpServers: Record<string, McpServerConfig>;
  skillsDir: string;
  compaction: { maxChars: number; keepMessages: number };
  subagent: { maxDepth: number; maxSteps: number };
}

export interface CliOverrides {
  provider?: string;
  model?: string;
  workspace?: string;
  maxSteps?: number;
  dryRun?: boolean;
  yes?: boolean;
  sandbox?: boolean;
}

const SECRET_LIKE = /api[_-]?key|secret|token|password|passwd/i;

function userConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg ? path.resolve(xdg) : path.join(homedir(), '.config');
  return path.join(base, 'mola', 'mola.json');
}

function projectConfigPath(workspace: string): string {
  return path.join(workspace, '.mola', 'mola.json');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(file: string, msg: string): never {
  throw new Error(`invalid config in ${file}: ${msg}`);
}

function readConfigFile(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    fail(file, 'cannot be read');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text!);
  } catch (e) {
    fail(file, `not valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!isRecord(parsed)) fail(file, 'top level must be a JSON object');
  for (const key of Object.keys(parsed)) {
    if (SECRET_LIKE.test(key)) {
      fail(
        file,
        `key "${key}" looks like a secret; config files must never contain secrets — ` +
          'set MOLA_API_KEY (or DEEPSEEK_API_KEY) in the environment instead',
      );
    }
  }
  return parsed;
}

const KNOWN_KEYS = new Set([
  'provider', 'model', 'baseUrl', 'maxSteps', 'dryRun', 'yes', 'sandbox',
  'requestTimeoutMs', 'maxRetries', 'permissions', 'hooks', 'bashAllowlist',
  'mcpServers', 'skillsDir', 'compaction', 'subagent',
]);

function checkKeys(file: string, obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    if (!KNOWN_KEYS.has(key)) {
      fail(file, `unknown key "${key}" (known keys: ${[...KNOWN_KEYS].sort().join(', ')})`);
    }
  }
}

function asString(file: string, obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') fail(file, `"${key}" must be a string`);
  return v;
}

function asBool(file: string, obj: Record<string, unknown>, key: string): boolean | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') fail(file, `"${key}" must be a boolean`);
  return v;
}

function asPosInt(file: string, obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.floor(v) !== v || v <= 0) {
    fail(file, `"${key}" must be a positive integer`);
  }
  return v;
}

function asNonNegInt(file: string, obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.floor(v) !== v || v < 0) {
    fail(file, `"${key}" must be a non-negative integer`);
  }
  return v;
}

function asStringArray(file: string, obj: Record<string, unknown>, key: string): string[] | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    fail(file, `"${key}" must be an array of strings`);
  }
  return v as string[];
}

function asPermissions(file: string, obj: Record<string, unknown>): Record<string, PermissionRule> | undefined {
  const v = obj.permissions;
  if (v === undefined) return undefined;
  if (!isRecord(v)) fail(file, '"permissions" must be an object mapping tool name to "allow", "ask", or "deny"');
  const out: Record<string, PermissionRule> = {};
  for (const [tool, rule] of Object.entries(v)) {
    if (rule !== 'allow' && rule !== 'ask' && rule !== 'deny') {
      fail(file, `permissions["${tool}"] must be "allow", "ask", or "deny", got ${JSON.stringify(rule)}`);
    }
    out[tool] = rule;
  }
  return out;
}

function asHooks(file: string, obj: Record<string, unknown>): Record<string, string> | undefined {
  const v = obj.hooks;
  if (v === undefined) return undefined;
  if (!isRecord(v)) fail(file, '"hooks" must be an object mapping event name to a command string');
  const out: Record<string, string> = {};
  for (const [event, cmd] of Object.entries(v)) {
    if (typeof cmd !== 'string' || !cmd.trim()) {
      fail(file, `hooks["${event}"] must be a non-empty command string`);
    }
    out[event] = cmd;
  }
  return out;
}

function asMcpServers(file: string, obj: Record<string, unknown>): Record<string, McpServerConfig> | undefined {
  const v = obj.mcpServers;
  if (v === undefined) return undefined;
  if (!isRecord(v)) fail(file, '"mcpServers" must be an object mapping server name to {command, args?, env?}');
  const out: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(v)) {
    if (!isRecord(entry) || typeof entry.command !== 'string' || !entry.command.trim()) {
      fail(file, `mcpServers["${name}"].command must be a non-empty string`);
    }
    const server: McpServerConfig = { command: entry.command };
    if (entry.args !== undefined) {
      if (!Array.isArray(entry.args) || entry.args.some((x) => typeof x !== 'string')) {
        fail(file, `mcpServers["${name}"].args must be an array of strings`);
      }
      server.args = entry.args as string[];
    }
    if (entry.env !== undefined) {
      if (!isRecord(entry.env) || Object.values(entry.env).some((x) => typeof x !== 'string')) {
        fail(file, `mcpServers["${name}"].env must be an object of string values`);
      }
      server.env = entry.env as Record<string, string>;
    }
    out[name] = server;
  }
  return out;
}

function asCompaction(file: string, obj: Record<string, unknown>): { maxChars: number; keepMessages: number } | undefined {
  const v = obj.compaction;
  if (v === undefined) return undefined;
  if (!isRecord(v)) fail(file, '"compaction" must be an object {maxChars, keepMessages}');
  const out: { maxChars: number; keepMessages: number } = { maxChars: 24_000, keepMessages: 8 };
  if (v.maxChars !== undefined) {
    if (typeof v.maxChars !== 'number' || v.maxChars <= 0) fail(file, '"compaction.maxChars" must be a positive number');
    out.maxChars = Math.floor(v.maxChars);
  }
  if (v.keepMessages !== undefined) {
    if (typeof v.keepMessages !== 'number' || v.keepMessages < 2 || Math.floor(v.keepMessages) !== v.keepMessages) {
      fail(file, '"compaction.keepMessages" must be an integer >= 2');
    }
    out.keepMessages = v.keepMessages;
  }
  return out;
}

function asSubagent(file: string, obj: Record<string, unknown>): { maxDepth: number; maxSteps: number } | undefined {
  const v = obj.subagent;
  if (v === undefined) return undefined;
  if (!isRecord(v)) fail(file, '"subagent" must be an object {maxDepth, maxSteps}');
  const out: { maxDepth: number; maxSteps: number } = { maxDepth: 1, maxSteps: 5 };
  if (v.maxDepth !== undefined) {
    if (typeof v.maxDepth !== 'number' || v.maxDepth < 0 || Math.floor(v.maxDepth) !== v.maxDepth) {
      fail(file, '"subagent.maxDepth" must be a non-negative integer');
    }
    out.maxDepth = v.maxDepth;
  }
  if (v.maxSteps !== undefined) {
    if (typeof v.maxSteps !== 'number' || v.maxSteps <= 0 || Math.floor(v.maxSteps) !== v.maxSteps) {
      fail(file, '"subagent.maxSteps" must be a positive integer');
    }
    out.maxSteps = v.maxSteps;
  }
  return out;
}

interface FileConfig {
  provider?: string;
  model?: string;
  baseUrl?: string;
  maxSteps?: number;
  dryRun?: boolean;
  yes?: boolean;
  sandbox?: boolean;
  requestTimeoutMs?: number;
  maxRetries?: number;
  permissions?: Record<string, PermissionRule>;
  hooks?: Record<string, string>;
  bashAllowlist?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  skillsDir?: string;
  compaction?: { maxChars: number; keepMessages: number };
  subagent?: { maxDepth: number; maxSteps: number };
}

function parseFile(file: string): FileConfig {
  const obj = readConfigFile(file);
  checkKeys(file, obj);
  return {
    provider: asString(file, obj, 'provider'),
    model: asString(file, obj, 'model'),
    baseUrl: asString(file, obj, 'baseUrl'),
    maxSteps: asPosInt(file, obj, 'maxSteps'),
    dryRun: asBool(file, obj, 'dryRun'),
    yes: asBool(file, obj, 'yes'),
    sandbox: asBool(file, obj, 'sandbox'),
    requestTimeoutMs: asPosInt(file, obj, 'requestTimeoutMs'),
    maxRetries: asNonNegInt(file, obj, 'maxRetries'),
    permissions: asPermissions(file, obj),
    hooks: asHooks(file, obj),
    bashAllowlist: asStringArray(file, obj, 'bashAllowlist'),
    mcpServers: asMcpServers(file, obj),
    skillsDir: asString(file, obj, 'skillsDir'),
    compaction: asCompaction(file, obj),
    subagent: asSubagent(file, obj),
  };
}

function mergeFileConfigs(user: FileConfig, project: FileConfig): FileConfig {
  // Project wins per scalar key; nested objects merge per key; the bash
  // allowlist is additive (union), because it only ever extends the default.
  const merged: FileConfig = { ...user, ...project };
  merged.permissions = { ...(user.permissions ?? {}), ...(project.permissions ?? {}) };
  merged.hooks = { ...(user.hooks ?? {}), ...(project.hooks ?? {}) };
  merged.mcpServers = { ...(user.mcpServers ?? {}), ...(project.mcpServers ?? {}) };
  merged.compaction = { ...(user.compaction ?? {}), ...(project.compaction ?? {}) } as FileConfig['compaction'];
  merged.subagent = { ...(user.subagent ?? {}), ...(project.subagent ?? {}) } as FileConfig['subagent'];
  merged.bashAllowlist = [...new Set([...(user.bashAllowlist ?? []), ...(project.bashAllowlist ?? [])])];
  return merged;
}

function envBool(name: string): boolean | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  if (v === '1' || v.toLowerCase() === 'true') return true;
  if (v === '0' || v.toLowerCase() === 'false') return false;
  throw new Error(`environment variable ${name} must be 1/0 or true/false, got ${JSON.stringify(v)}`);
}

function envInt(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || Math.floor(n) !== n) {
    throw new Error(`environment variable ${name} must be an integer, got ${JSON.stringify(v)}`);
  }
  return n;
}

export function loadConfig(overrides: CliOverrides): Config {
  // Workspace is resolved first: the project config lives inside it.
  const workspace = path.resolve(
    overrides.workspace ?? process.env.MOLA_WORKSPACE ?? process.cwd(),
  );
  const userFile = userConfigPath();
  const projectFile = projectConfigPath(workspace);
  const fileCfg = mergeFileConfigs(parseFile(userFile), parseFile(projectFile));

  const providerRaw = overrides.provider ?? process.env.MOLA_PROVIDER ?? fileCfg.provider ?? 'mock';
  if (providerRaw !== 'mock' && providerRaw !== 'deepseek' && providerRaw !== 'custom') {
    throw new Error(`unknown provider: ${providerRaw} (expected mock, deepseek, or custom)`);
  }
  const provider = providerRaw as ProviderName;

  const apiKey = process.env.MOLA_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? null;
  if (provider !== 'mock' && !apiKey) {
    throw new Error(
      `provider ${provider} needs an API key: set MOLA_API_KEY ` +
        (provider === 'deepseek' ? '(or DEEPSEEK_API_KEY)' : '') +
        ' in the environment',
    );
  }

  const resolvedBaseUrl = provider === 'deepseek'
    ? (process.env.MOLA_BASE_URL ?? fileCfg.baseUrl ?? 'https://api.deepseek.com/v1')
    : (process.env.MOLA_BASE_URL ?? fileCfg.baseUrl ?? null);
  if (provider === 'custom' && !resolvedBaseUrl) {
    throw new Error('custom provider needs a base URL: set MOLA_BASE_URL or "baseUrl" in mola.json');
  }

  let model: string;
  if (overrides.model !== undefined) model = overrides.model;
  else if (process.env.MOLA_MODEL !== undefined) model = process.env.MOLA_MODEL;
  else if (fileCfg.model !== undefined) model = fileCfg.model;
  else if (provider === 'deepseek') model = 'deepseek-chat';
  else if (provider === 'mock') model = 'mock';
  else throw new Error('custom provider needs a model: set --model, MOLA_MODEL, or "model" in mola.json');

  const maxStepsEnv = envInt('MOLA_MAX_STEPS');
  const maxSteps = overrides.maxSteps ?? maxStepsEnv ?? fileCfg.maxSteps ?? 10;
  if (!Number.isFinite(maxSteps) || maxSteps <= 0 || Math.floor(maxSteps) !== maxSteps) {
    throw new Error(`max steps must be a positive integer, got ${maxSteps}`);
  }

  const requestTimeoutMs = envInt('MOLA_REQUEST_TIMEOUT_MS') ?? fileCfg.requestTimeoutMs ?? 120_000;
  const maxRetries = envInt('MOLA_MAX_RETRIES') ?? fileCfg.maxRetries ?? 3;

  return {
    provider,
    model,
    apiKey,
    baseUrl: resolvedBaseUrl,
    workspace,
    maxSteps,
    dryRun: overrides.dryRun ?? envBool('MOLA_DRY_RUN') ?? fileCfg.dryRun ?? false,
    yes: overrides.yes ?? envBool('MOLA_YES') ?? fileCfg.yes ?? false,
    sandbox: overrides.sandbox ?? envBool('MOLA_SANDBOX') ?? fileCfg.sandbox ?? false,
    requestTimeoutMs,
    maxRetries,
    permissions: fileCfg.permissions ?? {},
    hooks: fileCfg.hooks ?? {},
    bashAllowlist: fileCfg.bashAllowlist ?? [],
    mcpServers: fileCfg.mcpServers ?? {},
    skillsDir: fileCfg.skillsDir ?? 'skills',
    compaction: {
      maxChars: fileCfg.compaction?.maxChars ?? 24_000,
      keepMessages: fileCfg.compaction?.keepMessages ?? 8,
    },
    subagent: {
      maxDepth: fileCfg.subagent?.maxDepth ?? 1,
      maxSteps: fileCfg.subagent?.maxSteps ?? 5,
    },
  };
}

export { userConfigPath, projectConfigPath };
