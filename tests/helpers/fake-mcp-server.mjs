// Minimal fake MCP server speaking JSON-RPC 2.0 over stdio.
// Tools: echo (returns its input as text), fail (isError), slow (5s delay).
// Usage: node tests/helpers/fake-mcp-server.mjs

import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === 'notifications/initialized' || msg.method === undefined) return;
  const respond = (result) => {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
  };
  const respondError = (message) => {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message } }) + '\n');
  };
  if (msg.method === 'initialize') {
    respond({ protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake-mcp', version: '0.0.0' } });
  } else if (msg.method === 'tools/list') {
    respond({
      tools: [
        { name: 'echo', description: 'Echo the input back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
        { name: 'fail', description: 'Always reports an error', inputSchema: { type: 'object', properties: {} } },
        { name: 'slow', description: 'Responds after 5 seconds', inputSchema: { type: 'object', properties: {} } },
      ],
    });
  } else if (msg.method === 'tools/call') {
    const name = msg.params?.name;
    if (name === 'echo') {
      respond({ content: [{ type: 'text', text: `echo:${msg.params?.arguments?.text ?? ''}` }] });
    } else if (name === 'fail') {
      respond({ content: [{ type: 'text', text: 'boom' }], isError: true });
    } else if (name === 'slow') {
      setTimeout(() => respond({ content: [{ type: 'text', text: 'slow-done' }] }), 5000);
    } else {
      respondError(`unknown tool: ${name}`);
    }
  } else {
    respondError(`unknown method: ${msg.method}`);
  }
});
