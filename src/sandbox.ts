// Optional bwrap sandbox for bash. When --sandbox is set and bwrap is
// available, bash runs inside a bubblewrap container: /usr, /lib, /bin
// read-only, the workspace bound read-write, /tmp fresh, no network
// namespace sharing. When bwrap is missing, the loop warns clearly and
// falls back to process-level isolation — it never pretends otherwise.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

let bwrapCache: boolean | null = null;

export function bwrapAvailable(): boolean {
  if (bwrapCache !== null) return bwrapCache;
  try {
    const r = spawnSync('bwrap', ['--version'], { encoding: 'utf8' });
    bwrapCache = r.status === 0;
  } catch {
    bwrapCache = false;
  }
  return bwrapCache;
}

/** Build the bwrap argv prefix for a command, or null when bwrap is absent. */
export function bwrapPrefix(workspace: string, pathEnv: string | undefined): string[] | null {
  if (!bwrapAvailable()) return null;
  const args: string[] = ['--unshare-all', '--die-with-parent'];
  for (const dir of ['/usr', '/lib', '/lib64', '/bin']) {
    if (existsSync(dir)) args.push('--ro-bind', dir, dir);
  }
  args.push('--bind', workspace, workspace);
  args.push('--tmpfs', '/tmp', '--proc', '/proc', '--dev', '/dev');
  args.push('--setenv', 'PATH', pathEnv ?? '/usr/bin:/bin');
  args.push('--chdir', workspace);
  return args;
}
