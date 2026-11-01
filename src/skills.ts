// Skills with progressive disclosure: a skills/ directory is scanned for
// SKILL.md files. Only each skill's name + one-line description goes into
// the system prompt; the full body is loaded on demand via the `skill`
// tool. Frontmatter is the small YAML subset `name:` / `description:`.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface Skill {
  name: string;
  description: string;
  path: string;
}

interface Frontmatter {
  name?: string;
  description?: string;
}

export function parseFrontmatter(text: string): Frontmatter | null {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  const fm: Frontmatter = {};
  for (const line of text.slice(3, end).split('\n')) {
    const m = line.match(/^\s*(name|description)\s*:\s*(.+?)\s*$/);
    if (m) fm[m[1] as 'name' | 'description'] = m[2].replace(/^['"]|['"]$/g, '');
  }
  if (!fm.name || !fm.description) return null;
  return fm;
}

export async function discoverSkills(skillsDir: string): Promise<Skill[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(skillsDir, { withFileTypes: true }).then((es) =>
      es.filter((e) => e.isDirectory()).map((e) => e.name),
    );
  } catch {
    return [];
  }
  const skills: Skill[] = [];
  for (const dir of entries.sort()) {
    const file = path.join(skillsDir, dir, 'SKILL.md');
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const fm = parseFrontmatter(text);
    if (!fm) continue;
    skills.push({ name: fm.name as string, description: fm.description as string, path: file });
  }
  return skills;
}

export function skillsPromptSection(skills: Skill[]): string {
  if (skills.length === 0) return '';
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
  return (
    'Available skills (load one with the skill tool when it fits the task; ' +
    'only names and one-line descriptions are shown here to save context):\n' +
    lines.join('\n')
  );
}
