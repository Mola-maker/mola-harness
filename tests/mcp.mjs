// MCP host tests: list/call/timeout/error against the fake stdio server,
// plus loadMcpTools skipping a dead server without breaking the loop.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpClient, loadMcpTools } from '../src/mcp.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fake = path.join(here, 'helpers', 'fake-mcp-server.mjs');

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

const client = new McpClient('fake', { command: process.execPath, args: [fake] });
await client.initialize();
const tools = await client.listTools();
check('tools/list returns 3 tools', tools.length === 3, JSON.stringify(tools.map((t) => t.name)));
check('schema carried over', tools.find((t) => t.name === 'echo')?.inputSchema?.properties?.text !== undefined);

const echo = await client.callTool('echo', { text: 'hi' });
check('tools/call echo works', echo.ok && echo.content === 'echo:hi', echo.content);
const fail = await client.callTool('fail', {});
check('isError becomes ok=false', !fail.ok && fail.content.includes('boom'), fail.content);
const unknown = await client.callTool('nope', {}).then(
  () => ({ ok: true }),
  (e) => ({ ok: false, msg: e.message }),
);
check('unknown tool call rejects', !unknown.ok, unknown.msg ?? '');

let timedOut = false;
try {
  await client.callTool('slow', {}, 200);
} catch (e) {
  timedOut = String(e.message).includes('timed out');
}
check('call timeout reported', timedOut);
client.close();

// loadMcpTools: good server registers tools, dead server is skipped.
const warnings = [];
const { tools: loaded, closeAll } = await loadMcpTools(
  {
    fake: { command: process.execPath, args: [fake] },
    dead: { command: '/nonexistent-binary-xyz', args: [] },
  },
  (msg) => warnings.push(msg),
);
check('loadMcpTools registers fake tools', loaded.some((t) => t.def.name === 'mcp_fake_echo'), loaded.map((t) => t.def.name).join(','));
check('dead server warned, not fatal', warnings.some((w) => w.includes('"dead"')), warnings.join(' | '));
const viaLoaded = await loaded.find((t) => t.def.name === 'mcp_fake_echo').run({ text: 'yo' }, { workspace: '/tmp' });
check('registered MCP tool callable', viaLoaded.ok && viaLoaded.content === 'echo:yo', viaLoaded.content);
closeAll();

// Unstarted client errors cleanly.
const cold = new McpClient('cold', { command: process.execPath, args: [fake] });
let coldFailed = false;
try {
  await cold.listTools(500);
} catch {
  coldFailed = true;
}
check('unstarted client fails (not hangs)', coldFailed);

if (failures > 0) {
  console.log(`MCP FAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log('MCP OK');
process.exit(0);
