// Allow/ask/deny permissions, per tool name.
// Resolution order: explicit tool rule > "mcp:*" wildcard (for MCP tools)
// > built-in default for known tools > "default" rule > ask.
// An "ask" decision prompts on a TTY, denies when non-interactive, and is
// overridden to allow by --yes. Every decision is logged by the loop.

import type { PermissionRule } from './config.ts';

export type PermissionDecision = 'allow' | 'deny';

const BUILTIN_DEFAULTS: Record<string, PermissionRule> = {
  read: 'allow',
  glob: 'allow',
  grep: 'allow',
  skill: 'allow',
  bash: 'allow', // still gated by the command allowlist
  write: 'ask',
  subagent: 'ask',
};

export function resolveRule(tool: string, rules: Record<string, PermissionRule>): PermissionRule {
  if (rules[tool] !== undefined) return rules[tool];
  if (tool.startsWith('mcp_') && rules['mcp:*'] !== undefined) return rules['mcp:*'];
  if (tool.startsWith('mcp_')) return 'ask';
  if (BUILTIN_DEFAULTS[tool] !== undefined) return BUILTIN_DEFAULTS[tool];
  if (rules.default !== undefined) return rules.default;
  return 'ask';
}

export interface AskContext {
  /** True when --yes was passed. */
  yes: boolean;
  /** Prompt the user; null means non-interactive (ask becomes deny). */
  asker: ((tool: string, args: Record<string, unknown>) => Promise<boolean>) | null;
}

export async function decidePermission(
  tool: string,
  args: Record<string, unknown>,
  rules: Record<string, PermissionRule>,
  ctx: AskContext,
): Promise<{ decision: PermissionDecision; rule: PermissionRule; asked: boolean }> {
  const rule = resolveRule(tool, rules);
  if (rule === 'allow') return { decision: 'allow', rule, asked: false };
  if (rule === 'deny') return { decision: 'deny', rule, asked: false };
  // rule === 'ask'
  if (ctx.yes) return { decision: 'allow', rule, asked: false };
  if (ctx.asker === null) return { decision: 'deny', rule, asked: false };
  const ok = await ctx.asker(tool, args);
  return { decision: ok ? 'allow' : 'deny', rule, asked: true };
}
