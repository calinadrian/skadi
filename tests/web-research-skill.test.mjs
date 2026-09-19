import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkillStore } from '../src/skills.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the bundled web research skill is discoverable and loadable', async () => {
  const store = new SkillStore(join(root, 'defaults', 'skills'));
  const listed = await store.list();
  const skill = listed.find((item) => item.name === 'web-research');
  assert.ok(skill);
  assert.match(skill.description, /web_search/);
  const loaded = await store.load('web-research');
  assert.match(loaded.body, /Prefer primary sources/);
  assert.match(loaded.body, /private workspace content/);
});
