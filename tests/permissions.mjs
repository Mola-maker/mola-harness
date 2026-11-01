// Permission tests: rule resolution + ask semantics (pure, no TTY).

import { resolveRule, decidePermission } from '../src/permissions.ts';

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

check('explicit rule wins', resolveRule('write', { write: 'deny' }) === 'deny');
check('mcp:* wildcard applies', resolveRule('mcp_srv_echo', { 'mcp:*': 'deny' }) === 'deny');
check('mcp default is ask', resolveRule('mcp_srv_echo', {}) === 'ask');
check('builtin read default allow', resolveRule('read', {}) === 'allow');
check('builtin write default ask', resolveRule('write', {}) === 'ask');
check('builtin bash default allow', resolveRule('bash', {}) === 'allow');
check('default rule for unknown tool', resolveRule('weird', { default: 'deny' }) === 'deny');
check('unknown tool without default asks', resolveRule('weird', {}) === 'ask');

const neverAsk = async () => {
  throw new Error('asker must not be called');
};
let r = await decidePermission('read', {}, {}, { yes: false, asker: neverAsk });
check('allow rule never asks', r.decision === 'allow' && !r.asked);
r = await decidePermission('write', {}, { write: 'deny' }, { yes: true, asker: neverAsk });
check('deny beats --yes', r.decision === 'deny');
r = await decidePermission('write', {}, {}, { yes: true, asker: neverAsk });
check('--yes turns ask into allow', r.decision === 'allow' && !r.asked);
r = await decidePermission('write', {}, {}, { yes: false, asker: null });
check('ask without TTY denies', r.decision === 'deny' && !r.asked);
r = await decidePermission('write', {}, {}, { yes: false, asker: async () => true });
check('ask with yes answer allows', r.decision === 'allow' && r.asked);
r = await decidePermission('write', {}, {}, { yes: false, asker: async () => false });
check('ask with no answer denies', r.decision === 'deny' && r.asked);

if (failures > 0) {
  console.log(`PERMISSIONS FAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log('PERMISSIONS OK');
