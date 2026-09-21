import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { SkillStore, seedBundledSkills } from '../src/skills.mjs';
import { releaseFiles } from '../src/release.mjs';

const root = join(import.meta.dirname, '..');
const exec = promisify(execFile);

test('the bundled UI/UX skill is loadable and ships in releases', async () => {
  const skillRoot = join(root, 'defaults', 'skills', 'ui-ux-pro-max');
  const store = new SkillStore(join(root, 'defaults', 'skills'));
  const skill = await store.load('ui-ux-pro-max');
  assert.match(skill.description, /searchable local data/i);
  assert.ok(skill.body.length > 10000, 'the loaded body should contain the complete workflow, not a reduced imitation');
  assert.doesNotMatch(skill.body, /\$\{CLAUDE_PLUGIN_ROOT\}/, 'portable paths should resolve when the skill is loaded');
  assert.match(skill.body, /defaults\/skills\/ui-ux-pro-max\/scripts\/search\.py/i);

  const shipped = await releaseFiles(root);
  const bundledFiles = shipped.filter((file) => file.startsWith('defaults/skills/ui-ux-pro-max/'));
  assert.ok(bundledFiles.length > 60, 'the release should carry the full skill package');
  for (const required of [
    'SKILL.md',
    'scripts/search.py',
    'scripts/search.mjs',
    'scripts/design_system.py',
    'data/ux-guidelines.csv',
    'data/ui-reasoning.csv',
    'references/quick-reference.md',
    'references/pro-rules.md',
  ]) {
    assert.ok(bundledFiles.includes(`defaults/skills/ui-ux-pro-max/${required}`), `release is missing ${required}`);
  }

  const topLevel = await readdir(skillRoot);
  assert.deepEqual(topLevel.sort(), ['SKILL.md', 'data', 'references', 'scripts']);
});

test('the portable UI/UX search works without Python', async () => {
  const script = join(root, 'defaults', 'skills', 'ui-ux-pro-max', 'scripts', 'search.mjs');
  const { stdout } = await exec(process.execPath, [script, 'keyboard focus modal', '--domain', 'ux', '--json']);
  const result = JSON.parse(stdout);
  assert.equal(result.domain, 'ux');
  assert.ok(result.count > 0);
  assert.match(JSON.stringify(result.results), /focus|keyboard/i);

  const design = await exec(process.execPath, [script, 'internal analytics dashboard', '--design-system', '-p', 'Ops Console']);
  assert.match(design.stdout, /Data-Dense Dashboard/);
  assert.doesNotMatch(design.stdout, /AI Personalization Landing/);
});

test('bundled skills are seeded after an update without replacing user skills', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'skadi-skill-seed-'));
  const target = join(temp, 'skills');
  assert.ok(seedBundledSkills(join(root, 'defaults', 'skills'), target).includes('ui-ux-pro-max'));
  assert.ok((await readdir(join(target, 'ui-ux-pro-max', 'data'))).includes('ux-guidelines.csv'));

  await writeFile(join(target, 'ui-ux-pro-max', 'SKILL.md'), 'mine');
  assert.deepEqual(seedBundledSkills(join(root, 'defaults', 'skills'), target), []);
  assert.equal(await readFile(join(target, 'ui-ux-pro-max', 'SKILL.md'), 'utf8'), 'mine');
});
