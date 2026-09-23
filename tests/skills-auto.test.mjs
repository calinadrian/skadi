import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SkillStore, autoSkills, bundledSkillStatus, quickStart, restoreBundledSkill, seedBundledSkills,
} from '../src/skills.mjs';

const root = join(import.meta.dirname, '..');
const bundled = join(root, 'defaults', 'skills');

test('every bundled skill has a quick start and a working trigger', async () => {
  const store = new SkillStore(bundled);
  for (const skill of await store.list()) {
    const { body } = await store.load(skill.name);
    assert.ok(quickStart(body).length > 200, `${skill.name} needs a "## Quick start" a small model can follow`);
    assert.ok(skill.triggers, `${skill.name} needs triggers`);
    assert.doesNotThrow(() => new RegExp(skill.triggers, 'i'), `${skill.name} triggers must be a valid pattern`);
    assert.doesNotMatch(body, /\$\{CLAUDE_PLUGIN_ROOT\}/);
  }
});

test('requests pick the right skills, and ordinary work picks none', async () => {
  const skills = await new SkillStore(bundled).list();
  const names = (text) => autoSkills(skills, text).map((s) => s.name);
  assert.deepEqual(names('draw a pixel art sword for my game'), ['pixel-art']);
  assert.ok(names('build a landing page for a bakery').includes('ui-ux-pro-max'));
  assert.deepEqual(names('look it up online: what is new in Node 24'), ['web-research']);
  assert.deepEqual(names('rename the helper and fix the failing test'), []);
  assert.deepEqual(names(''), []);
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'skadi-skills-'));
  const defaults = join(dir, 'defaults');
  const installed = join(dir, 'skills');
  await mkdir(join(defaults, 'helper'), { recursive: true });
  await writeFile(join(defaults, 'helper', 'SKILL.md'), '---\nname: helper\ndescription: v1\n---\n\nversion one\n');
  return { defaults, installed };
}

test('an unedited bundled skill follows app updates; an edited one is never touched', async () => {
  const { defaults, installed } = await fixture();
  assert.deepEqual(seedBundledSkills(defaults, installed), ['helper']);

  // The app ships version two; the copy was never edited, so it updates.
  await writeFile(join(defaults, 'helper', 'SKILL.md'), '---\nname: helper\ndescription: v2\n---\n\nversion two\n');
  assert.deepEqual(seedBundledSkills(defaults, installed), ['helper']);
  assert.match(await readFile(join(installed, 'helper', 'SKILL.md'), 'utf8'), /version two/);

  // The user edits it; version three must not overwrite that.
  await writeFile(join(installed, 'helper', 'SKILL.md'), '---\nname: helper\ndescription: mine\n---\n\nmy own steps\n');
  await writeFile(join(defaults, 'helper', 'SKILL.md'), '---\nname: helper\ndescription: v3\n---\n\nversion three\n');
  assert.deepEqual(seedBundledSkills(defaults, installed), []);
  assert.match(await readFile(join(installed, 'helper', 'SKILL.md'), 'utf8'), /my own steps/);
  assert.equal(bundledSkillStatus(defaults, installed).helper, 'edited');

  // Until the user asks for the built-in version back.
  restoreBundledSkill(defaults, installed, 'helper');
  assert.match(await readFile(join(installed, 'helper', 'SKILL.md'), 'utf8'), /version three/);
  assert.equal(bundledSkillStatus(defaults, installed).helper, 'current');
  assert.throws(() => restoreBundledSkill(defaults, installed, 'not-bundled'), /not a built-in skill/);
});

test('saving a skill from the editor keeps its auto-load triggers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skadi-skills-'));
  const store = new SkillStore(dir);
  await mkdir(join(dir, 'art'));
  await writeFile(join(dir, 'art', 'SKILL.md'), '---\nname: art\ndescription: d\ntriggers: pixel art\n---\n\nbody\n');
  await store.save('art', 'new description', 'new body');
  const [skill] = await store.list();
  assert.equal(skill.triggers, 'pixel art');
  assert.equal(skill.description, 'new description');
});
