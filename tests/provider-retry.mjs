// Provider retry tests against a local HTTP server (loopback only,
// no external network): 429 with Retry-After, 500s, exhaustion, timeout,
// malformed tool arguments.

import { createServer } from 'node:http';
import { OpenAICompatibleProvider } from '../src/providers.ts';

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

function okBody(content = 'hello', toolCalls = []) {
  return JSON.stringify({ choices: [{ message: { content, tool_calls: toolCalls } }] });
}

async function withServer(behavior, fn) {
  let i = 0;
  const server = createServer((req, res) => {
    const step = behavior[Math.min(i++, behavior.length - 1)];
    if (step.status) {
      if (step.retryAfter !== undefined) res.setHeader('Retry-After', String(step.retryAfter));
      res.writeHead(step.status, { 'Content-Type': 'application/json' });
      res.end(step.body ?? '{}');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(step.body ?? okBody());
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
  return i;
}

const baseReq = { model: 'test', messages: [{ role: 'user', content: 'hi' }], tools: [] };

// 429 with Retry-After 0, then success.
let n = await withServer(
  [{ status: 429, retryAfter: 0 }, { body: okBody('after-429') }],
  async (base) => {
    const p = new OpenAICompatibleProvider(base, 'k', { maxRetries: 3 });
    const r = await p.complete(baseReq);
    check('429 retried then success', r.text === 'after-429', r.text);
  },
);
check('429 case used 2 requests', n === 2, String(n));

// Two 500s, then success (exponential backoff path).
n = await withServer(
  [{ status: 500 }, { status: 500 }, { body: okBody('after-500s') }],
  async (base) => {
    const p = new OpenAICompatibleProvider(base, 'k', { maxRetries: 3 });
    const r = await p.complete(baseReq);
    check('500s retried then success', r.text === 'after-500s', r.text);
  },
);
check('500 case used 3 requests', n === 3, String(n));

// Exhaustion: 500 forever with maxRetries 2 -> throws after 3 requests.
n = await withServer(
  [{ status: 500 }],
  async (base) => {
    const p = new OpenAICompatibleProvider(base, 'k', { maxRetries: 2 });
    let threw = false;
    try {
      await p.complete(baseReq);
    } catch (e) {
      threw = String(e.message).includes('HTTP 500');
    }
    check('retries exhausted throws HTTP 500', threw);
  },
);
check('exhaustion used 3 requests (1 + 2 retries)', n === 3, String(n));

// 400 is not retryable: exactly 1 request.
n = await withServer(
  [{ status: 400, body: '{"error":"bad"}' }],
  async (base) => {
    const p = new OpenAICompatibleProvider(base, 'k', { maxRetries: 3 });
    let threw = false;
    try {
      await p.complete(baseReq);
    } catch (e) {
      threw = String(e.message).includes('HTTP 400');
    }
    check('400 not retried, throws', threw);
  },
);
check('400 case used 1 request', n === 1, String(n));

// Malformed tool arguments (non-object JSON) become a marked call,
// and the loop (not the provider) turns it into a tool error.
await withServer(
  [{ body: okBody('', [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '"just a string"' } }]) }],
  async (base) => {
    const p = new OpenAICompatibleProvider(base, 'k', { maxRetries: 0 });
    const r = await p.complete(baseReq);
    check('non-object tool args marked malformed', r.toolCalls[0]?.args?.__malformed === true, JSON.stringify(r.toolCalls[0]?.args));
  },
);

// Tool args that are not valid JSON at all -> empty object, no crash.
await withServer(
  [{ body: okBody('', [{ id: 'c2', type: 'function', function: { name: 'read', arguments: '{oops' } }]) }],
  async (base) => {
    const p = new OpenAICompatibleProvider(base, 'k', { maxRetries: 0 });
    const r = await p.complete(baseReq);
    check('invalid JSON tool args become {}', JSON.stringify(r.toolCalls[0]?.args) === '{}', JSON.stringify(r.toolCalls[0]?.args));
  },
);

// Request timeout: server never responds, short timeout + no retries.
{
  const server = createServer(() => {
    // Never respond.
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const p = new OpenAICompatibleProvider(`http://127.0.0.1:${port}`, 'k', { timeoutMs: 300, maxRetries: 0 });
  const start = Date.now();
  let threw = false;
  try {
    await p.complete(baseReq);
  } catch {
    threw = true;
  }
  const elapsed = Date.now() - start;
  check('request timeout throws promptly', threw && elapsed < 5000, `${elapsed}ms`);
  server.close();
}

if (failures > 0) {
  console.log(`PROVIDER-RETRY FAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log('PROVIDER-RETRY OK');
process.exit(0);
