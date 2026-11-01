// Helper for the SIGINT test: runs a loop with a provider that never
// resolves, prints the session path, and waits. The parent test sends
// SIGINT and checks the session log ends with an interrupted marker.

import { runLoop } from '../../src/loop.ts';

const ws = process.argv[2];
// A bare pending promise keeps no event-loop handle alive, so hold one
// explicitly until the run ends; SIGINT must still end it gracefully.
const keepAlive = setInterval(() => {}, 60_000);
class HangingProvider {
  complete() {
    return new Promise(() => {
      // Never resolves; SIGINT must still end the run gracefully.
    });
  }
}
const out = await runLoop('hanging task', {
  provider: new HangingProvider(),
  model: 'mock',
  workspace: ws,
  maxSteps: 10,
  dryRun: false,
  yes: true,
  sandbox: false,
  permissions: {},
  hooks: {},
  skillsDir: `${ws}/skills`,
  mcpServers: {},
  bashAllowlistExtra: [],
  compaction: { maxChars: 24_000, keepMessages: 8 },
  subagent: { maxDepth: 1, maxSteps: 5 },
  asker: null,
});
console.log(`OUTCOME interrupted=${out.interrupted} path=${out.sessionPath}`);
clearInterval(keepAlive);
