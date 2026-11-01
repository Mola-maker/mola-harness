// Lifecycle hooks: user-configured commands run at session:start,
// before-tool, after-tool, and session:end. A hook runs with a timeout and
// a small scrubbed environment plus MOLA_HOOK_* variables. A hook failure
// (non-zero exit, timeout, spawn error) is logged and NEVER breaks the loop.

import { execFile } from 'node:child_process';

export interface HookEvent {
  event: 'session:start' | 'before-tool' | 'after-tool' | 'session:end';
  tool?: string;
  ok?: boolean;
  sessionId?: string;
}

export interface HookResult {
  ok: boolean;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

const HOOK_TIMEOUT_MS = 10_000;
const HOOK_OUTPUT_CHARS = 4_000;

function scrubEnv(): Record<string, string> {
  const keep = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TERM'];
  const out: Record<string, string> = {};
  for (const k of keep) {
    if (process.env[k] !== undefined) out[k] = process.env[k] as string;
  }
  return out;
}

export async function runHook(
  command: string,
  event: HookEvent,
  workspace: string,
): Promise<HookResult> {
  const env: Record<string, string> = {
    ...scrubEnv(),
    MOLA_HOOK_EVENT: event.event,
    MOLA_HOOK_JSON: JSON.stringify(event),
  };
  if (event.tool !== undefined) env.MOLA_HOOK_TOOL = event.tool;
  if (event.sessionId !== undefined) env.MOLA_HOOK_SESSION = event.sessionId;
  return new Promise<HookResult>((resolve) => {
    execFile(
      'sh',
      ['-c', command],
      { cwd: workspace, timeout: HOOK_TIMEOUT_MS, maxBuffer: HOOK_OUTPUT_CHARS, env, shell: false },
      (error, stdout, stderr) => {
        const e = error as { code?: unknown; killed?: boolean } | null;
        const timedOut = e?.killed === true;
        const code = e && typeof e.code === 'number' ? e.code : null;
        resolve({
          ok: !error,
          timedOut,
          stdout: String(stdout).slice(0, HOOK_OUTPUT_CHARS),
          stderr: String(stderr).slice(0, HOOK_OUTPUT_CHARS),
          code,
        });
      },
    );
  });
}
