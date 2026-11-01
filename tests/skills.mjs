// Skill tests: discovery, frontmatter parsing, progressive disclosure
// (system prompt lists names only), on-demand full load via the tool.

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverSkills, parseFrontmatter, skillsPromptSection } from '../src/skills.ts';
import { runTool } from '../src/tools.ts';

const ws = mkdtempSync(path.join(tmpdir(), 'mola-skills-'));
mkdirSync(path.join(ws, 'skills', 'review'), { recursive: true });
mkdirSync(path.join(ws, 'skills', 'broken'), { recursive: true });
mkdirSync(path.join(ws, 'skills', 'plain'), { recursive: true });
writeFileSync(
  path.join(ws, 'skills', 'review', 'SKILL.md'),
  '---\nname: review\ndescription: Review a diff carefully before approving it.\n---\n\n# Review\n\nFull body: check every hunk, never skim.\n',
  'utf8',
);
writeFileSync(path.join(ws, 'skills', 'broken', 'SKILL.md'), '---\nname: broken\n---\n\nNo description, must be skipped.\n', 'utf8');
writeFileSync(path.join(ws, 'skills', 'plain', 'SKILL.md'), 'No frontmatter at all.\n', 'utf8');

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

check('frontmatter parses', (() => {
  const fm = parseFrontmatter('---\nname: x\ndescription: y\n---\nbody');
  return fm?.name === 'x' && fm?.description === 'y';
})());
check('frontmatter missing returns null', parseFrontmatter('no fm') === null);

const skills = await discoverSkills(path.join(ws, 'skills'));
check('only valid skills discovered', skills.length === 1 && skills[0].name === 'review', JSON.stringify(skills));
const section = skillsPromptSection(skills);
check('prompt section lists name + description', section.includes('review: Review a diff carefully'));
check('prompt section hides full body', !section.includes('never skim'));

const loaded = await runTool('skill', { name: 'review' }, { workspace: ws, skills });
check('skill tool loads full body', loaded.ok && loaded.content.includes('never skim'), loaded.content.slice(0, 100));
const missing = await runTool('skill', { name: 'nope' }, { workspace: ws, skills });
check('unknown skill errors as tool result', !missing.ok && missing.content.includes('unknown skill'));

const none = await discoverSkills(path.join(ws, 'no-such-dir'));
check('missing skills dir yields empty list', none.length === 0);

if (failures > 0) {
  console.log(`SKILLS FAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log('SKILLS OK');
