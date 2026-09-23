// Skills: reusable instruction packs the model can pull in on demand.
//
// Each lives at skills/<name>/SKILL.md with YAML front matter:
//
//   ---
//   name: reactive-ui
//   description: How to build reactive components in this codebase.
//   ---
//   ...body...
//
// Only the name and description go into the system prompt. The body is fetched
// via the load_skill tool when the model decides it is relevant. On a 27B model
// at ~39 t/s, that difference is the whole ballgame: ten skills inlined would
// cost thousands of prompt tokens on every single turn.
import { readFile, readdir, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, sep, dirname, basename } from 'node:path';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Which bundled skill text each installed copy started from. A copy whose
// text still matches has never been edited, so an app update may replace it;
// one that differs is the user's and is never touched automatically.
const MANIFEST = '.bundled.json';
const hashOf = (file) => (existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null);
const readManifest = (skillsDir) => {
  try { return JSON.parse(readFileSync(join(skillsDir, MANIFEST), 'utf8')); } catch { return {}; }
};

/**
 * Install starter skills, and keep unedited ones current. New bundled skills
 * are copied in; a bundled skill the user never edited is replaced when the
 * app ships a newer version; an edited one is left exactly as it is.
 * Returns the names added or updated.
 */
export function seedBundledSkills(defaultsDir, skillsDir) {
  if (!existsSync(defaultsDir)) return [];
  mkdirSync(skillsDir, { recursive: true });
  const manifest = readManifest(skillsDir);
  const changed = [];
  for (const entry of readdirSync(defaultsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const source = join(defaultsDir, entry.name);
    const target = join(skillsDir, entry.name);
    const bundled = hashOf(join(source, 'SKILL.md'));
    if (!existsSync(target)) {
      cpSync(source, target, { recursive: true, errorOnExist: true });
      manifest[entry.name] = bundled;
      changed.push(entry.name);
      continue;
    }
    const installed = hashOf(join(target, 'SKILL.md'));
    if (installed === bundled) {
      manifest[entry.name] = bundled;
    } else if (manifest[entry.name] && installed === manifest[entry.name]) {
      cpSync(source, target, { recursive: true, force: true });
      manifest[entry.name] = bundled;
      changed.push(entry.name);
    }
  }
  try { writeFileSync(join(skillsDir, MANIFEST), JSON.stringify(manifest, null, 2)); } catch { /* read-only install */ }
  return changed.sort();
}

/** Per bundled skill: 'current', 'edited' (differs from the built-in), or 'missing'. */
export function bundledSkillStatus(defaultsDir, skillsDir) {
  if (!existsSync(defaultsDir)) return {};
  const out = {};
  for (const entry of readdirSync(defaultsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const installed = hashOf(join(skillsDir, entry.name, 'SKILL.md'));
    out[entry.name] = !installed ? 'missing' : installed === hashOf(join(defaultsDir, entry.name, 'SKILL.md')) ? 'current' : 'edited';
  }
  return out;
}

/** Put one bundled skill back to the version that ships with the app. */
export function restoreBundledSkill(defaultsDir, skillsDir, name) {
  const id = skillSlug(name);
  const source = join(defaultsDir, id);
  if (!id || !existsSync(join(source, 'SKILL.md'))) throw new Error(`"${name}" is not a built-in skill`);
  const target = join(skillsDir, id);
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
  const manifest = readManifest(skillsDir);
  manifest[id] = hashOf(join(source, 'SKILL.md'));
  writeFileSync(join(skillsDir, MANIFEST), JSON.stringify(manifest, null, 2));
  return id;
}

/** The "## Quick start" section of a skill body, if it has one. */
export function quickStart(body) {
  const text = String(body || '');
  const start = /^##\s+Quick start\s*$/im.exec(text);
  if (!start) return '';
  const rest = text.slice(start.index + start[0].length);
  const end = /^##\s/m.exec(rest);
  return (end ? rest.slice(0, end.index) : rest).trim();
}

/**
 * Skills whose `triggers` pattern matches the request. Small models often
 * skip load_skill even when the catalogue names the right skill, so these are
 * handed to them directly.
 */
export function autoSkills(skills, text) {
  const request = String(text || '');
  if (!request.trim()) return [];
  return skills.filter((skill) => {
    if (!skill.triggers) return false;
    try { return new RegExp(`\\b(?:${skill.triggers})\\b`, 'i').test(request); } catch { return false; }
  });
}

/** Directory-safe identifier. Skill names become directory names, so unlike a
 *  display string this must never contain separators or parent references. */
export function skillSlug(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

/** Front matter is single-line scalars; a pasted newline would forge keys. */
export function oneLine(value, max = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Parse `---`-delimited front matter. Deliberately tiny: scalars only. */
export function parseFrontMatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { meta: {}, body: text.trim() };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    let value = kv[2].trim().replace(/^["']|["']$/g, '');
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    meta[kv[1]] = value;
  }
  return { meta, body: match[2].trim() };
}

export class SkillStore {
  constructor(dir) {
    this.dir = dir;
  }

  async list() {
    if (!existsSync(this.dir)) return [];
    const entries = await readdir(this.dir, { withFileTypes: true });
    const out = [];
    for (const entry of entries) {
      const file = entry.isDirectory()
        ? join(this.dir, entry.name, 'SKILL.md')
        : entry.name.endsWith('.md')
          ? join(this.dir, entry.name)
          : null;
      if (!file || !existsSync(file)) continue;
      const { meta, body } = parseFrontMatter(await readFile(file, 'utf8'));
      const name = meta.name || (entry.isDirectory() ? entry.name : entry.name.replace(/\.md$/, ''));
      out.push({
        name,
        description: meta.description || '(no description)',
        triggers: typeof meta.triggers === 'string' ? meta.triggers : '',
        file,
        bytes: body.length,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async load(name) {
    const skills = await this.list();
    const hit = skills.find((s) => s.name.toLowerCase() === String(name).toLowerCase());
    if (!hit) {
      const names = skills.map((s) => s.name).join(', ') || 'none installed';
      throw new Error(`no skill named "${name}". Available: ${names}`);
    }
    const { body } = parseFrontMatter(await readFile(hit.file, 'utf8'));
    const skillDir = dirname(hit.file);
    const bundledClaudePath = `\${CLAUDE_PLUGIN_ROOT}/.claude/skills/${basename(skillDir)}`;
    // Some portable skills were authored for Claude's plugin layout. Resolve
    // that conventional placeholder at load time so their scripts and data are
    // actually runnable from a Skadi installation at any path.
    const portableBody = body.replaceAll(bundledClaudePath, skillDir.replaceAll('\\', '/'));
    return { ...hit, body: portableBody };
  }

  async save(name, description, body, triggers) {
    const id = skillSlug(name);
    if (!id) throw new Error('skill needs a name');
    const dir = join(this.dir, id);
    await mkdir(dir, { recursive: true });
    // Editing a skill in the UI must not silently drop its auto-load pattern.
    let pattern = triggers;
    if (pattern === undefined && existsSync(join(dir, 'SKILL.md'))) {
      pattern = parseFrontMatter(await readFile(join(dir, 'SKILL.md'), 'utf8')).meta.triggers;
    }
    const triggerLine = typeof pattern === 'string' && pattern.trim() ? `triggers: ${oneLine(pattern, 500)}\n` : '';
    const text = `---\nname: ${id}\ndescription: ${oneLine(description)}\n${triggerLine}---\n\n${String(body || '').trim()}\n`;
    await writeFile(join(dir, 'SKILL.md'), text, 'utf8');
    return { name: id, description: oneLine(description) };
  }

  /** Delete a skill by name (directory or loose .md alike). */
  async remove(name) {
    const skills = await this.list();
    const hit = skills.find((s) => s.name.toLowerCase() === String(name).toLowerCase());
    if (!hit) throw new Error(`no skill named "${name}"`);
    // Directory skills point at their SKILL.md; remove the whole directory so
    // no empty shell is left behind. Loose .md skills remove just the file.
    let target = join(hit.file);
    if (basename(target).toLowerCase() === 'skill.md') target = dirname(target);
    // `hit.file` was built from a directory entry, not user input, but stay
    // inside the store anyway: a hostile skill name must not escape it.
    const base = this.dir.endsWith(sep) ? this.dir : this.dir + sep;
    if (target !== base.slice(0, -1) && !target.startsWith(base)) {
      throw new Error(`refusing to delete outside skills/: ${hit.file}`);
    }
    await rm(target, { recursive: true, force: true });
    return hit.name;
  }
}

/** The one-line-per-skill catalogue that goes in the system prompt. */
export function skillCatalogue(skills) {
  if (!skills.length) return '';
  const rows = skills.map((s) => `- ${s.name}: ${s.description}`).join('\n');
  return `## Skills\n\nInstruction packs available to you. Call load_skill with the name to read one in full before doing work it covers.\n\n${rows}`;
}

export function skillTools(store) {
  return {
    load_skill: {
      schema: {
        description:
          'Read a skill in full. Do this before starting work the skill covers, not after.',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
      },
      async run({ name }) {
        const skill = await store.load(name);
        return `# Skill: ${skill.name}\n\n${skill.body}`;
      },
    },
    save_skill: {
      mutates: true,
      schema: {
        description:
          'Write a new skill, or replace an existing one, so the approach is reusable in later sessions. Use when the user teaches you a repeatable procedure.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'kebab-case identifier' },
            description: { type: 'string', description: 'One line; this is what you will see next session when deciding whether to load it.' },
            body: { type: 'string', description: 'The instructions, in Markdown.' },
          },
          required: ['name', 'description', 'body'],
        },
      },
      async run({ name, description, body }) {
        await store.save(name, description, body);
        return `Saved skill "${name}".`;
      },
    },
  };
}
